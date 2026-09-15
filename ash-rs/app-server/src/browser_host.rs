use crate::resource_store::MAX_RESOURCE_BYTES;
use crate::resource_store::ResourceStore;
use crate::server::notification_queue::NotificationQueue;
use base64::Engine;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::collections::btree_map::Entry;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use ash_app_server_protocol::protocol::browser::BrowserCloseParams;
use ash_app_server_protocol::protocol::browser::BrowserCreateParams;
use ash_app_server_protocol::protocol::browser::BrowserCreateResult;
use ash_app_server_protocol::protocol::browser::BrowserElementTargetDto;
use ash_app_server_protocol::protocol::browser::BrowserObserveParams;
use ash_app_server_protocol::protocol::browser::BrowserObserveResult;
use ash_app_server_protocol::protocol::browser::BrowserPerformActionDto;
use ash_app_server_protocol::protocol::browser::BrowserPerformParams;
use ash_app_server_protocol::protocol::browser::BrowserPerformResult;
use ash_app_server_protocol::protocol::browser::BrowserTextInputTargetDto;
use ash_app_server_protocol::protocol::common::BrowserCapability as ClientBrowserCapability;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_app_server_protocol::rpc::JsonRpcError;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_protocol::rpc::JsonRpcNotification;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcResponse;
use ash_async_utils::CancellationToken;
use core_api::BrowserAction;
use core_api::BrowserActionResult;
use core_api::BrowserCapability;
use core_api::BrowserError;
use core_api::BrowserObservation;
use core_api::BrowserObserveRequest;
use core_api::BrowserTargetId;
use core_api::CreateBrowserTargetRequest;
use core_api::CreateBrowserTargetResult;
use core_api::BrowserMediaResource;
use core_api::BrowserTextInputTarget;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CANCELLATION_POLL: Duration = Duration::from_millis(50);
const RETIRED_REQUEST_LIMIT: usize = 1_024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Default)]
struct BrowserHostState {
    owners: BTreeMap<u64, BrowserHostOwner>,
    owner_revision: u64,
    target_owners: BTreeMap<String, u64>,
    pending: BTreeMap<String, PendingRequest>,
    retired: BTreeMap<String, RetiredRequest>,
    retired_order: VecDeque<String>,
    next_request_id: u64,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RetiredRequest {
    Completed,
    Abandoned,
}

impl BrowserHostState {
    fn retire(&mut self, request_id: String, outcome: RetiredRequest) {
        self.retired.insert(request_id.clone(), outcome);
        self.retired_order.push_back(request_id);
        while self.retired_order.len() > RETIRED_REQUEST_LIMIT {
            if let Some(oldest) = self.retired_order.pop_front() {
                self.retired.remove(&oldest);
            }
        }
    }
}

struct BrowserHostOwner {
    capability: ClientBrowserCapability,
    outbound: NotificationQueue,
}

struct PendingRequest {
    connection_id: u64,
    sender: mpsc::SyncSender<Result<Value, BrowserError>>,
}

/// Routes semantic Core browser requests to the exact capable client connection and target owner.
pub(crate) struct BrowserHost {
    state: Mutex<BrowserHostState>,
    resources: Arc<Mutex<ResourceStore>>,
}

impl BrowserHost {
    pub(crate) fn new(resources: Arc<Mutex<ResourceStore>>) -> Self {
        Self {
            state: Mutex::new(BrowserHostState::default()),
            resources,
        }
    }

    pub(crate) fn register(
        &self,
        connection_id: u64,
        capability: ClientBrowserCapability,
        outbound: NotificationQueue,
    ) {
        self.unregister(connection_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.owners.insert(
            connection_id,
            BrowserHostOwner {
                capability,
                outbound,
            },
        );
        state.owner_revision = state.owner_revision.wrapping_add(1);
    }

    pub(crate) fn unregister(&self, connection_id: u64) {
        let pending = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.owners.remove(&connection_id).is_some() {
                state.owner_revision = state.owner_revision.wrapping_add(1);
            }
            state
                .target_owners
                .retain(|_, owner| *owner != connection_id);
            let request_ids = state
                .pending
                .iter()
                .filter(|(_, pending)| pending.connection_id == connection_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            request_ids
                .into_iter()
                .filter_map(|request_id| state.pending.remove(&request_id))
                .collect::<Vec<_>>()
        };
        for pending in pending {
            let _ = pending
                .sender
                .send(Err(BrowserError::CapabilityUnavailable));
        }
    }

    pub(crate) fn owner_availability(&self) -> (u64, bool) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            state.owner_revision,
            state
                .owners
                .values()
                .any(|owner| owner.capability.observe && owner.capability.input),
        )
    }

    pub(crate) fn handle_response(
        &self,
        connection_id: u64,
        message: Value,
    ) -> Result<bool, String> {
        let Some(request_id) = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|request_id| request_id.starts_with("browser-host:"))
            .map(str::to_owned)
        else {
            return Ok(false);
        };
        let response = serde_json::from_value::<JsonRpcResponse<Value, JsonRpcError>>(message)
            .map_err(|error| format!("invalid browser host response: {error}"))?;
        let pending = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "browser host state lock poisoned".to_string())?;
            let Some(pending) = state.pending.get(&request_id) else {
                return match state.retired.get(&request_id) {
                    Some(RetiredRequest::Abandoned) => Ok(true),
                    Some(RetiredRequest::Completed) => {
                        Err(format!("duplicate browser host response: {request_id}"))
                    }
                    None => Err(format!(
                        "browser host response has unknown request ID: {request_id}"
                    )),
                };
            };
            if pending.connection_id != connection_id {
                return Err("browser host response came from a non-owning connection".into());
            }
            let pending = state
                .pending
                .remove(&request_id)
                .expect("browser host pending request was checked while locked");
            state.retire(request_id.clone(), RetiredRequest::Completed);
            pending
        };
        let result = match response {
            JsonRpcResponse::Success(success) => Ok(success.result),
            JsonRpcResponse::Failure(failure) => Err(host_error(failure.error)),
        };
        let _ = pending.sender.send(result);
        Ok(true)
    }

    fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        owner: u64,
        method: HostMethod,
        params: &P,
        cancellation: &CancellationToken,
    ) -> Result<R, BrowserError> {
        cancellation
            .check()
            .map_err(|signal| BrowserError::Cancelled(signal.reason().to_string()))?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let (request_id, outbound) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
            let outbound = state
                .owners
                .get(&owner)
                .map(|owner| owner.outbound.clone())
                .ok_or(BrowserError::CapabilityUnavailable)?;
            state.next_request_id = state
                .next_request_id
                .checked_add(1)
                .ok_or_else(|| BrowserError::Failed("browser host request ID exhausted".into()))?;
            let request_id = format!("browser-host:{owner}:{}", state.next_request_id);
            state.pending.insert(
                request_id.clone(),
                PendingRequest {
                    connection_id: owner,
                    sender,
                },
            );
            (request_id, outbound)
        };
        let request = JsonRpcRequest::new(
            JsonRpcId::String(request_id.clone()),
            method.as_str().into(),
            serde_json::to_value(params)
                .map_err(|error| BrowserError::Failed(error.to_string()))?,
        );
        outbound.push(
            serde_json::to_value(request)
                .map_err(|error| BrowserError::Failed(error.to_string()))?,
        );

        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let value = loop {
            match receiver.recv_timeout(CANCELLATION_POLL) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(BrowserError::CapabilityUnavailable)?;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Err(signal) = cancellation.check() {
                self.cancel_request(owner, &request_id);
                return Err(BrowserError::Cancelled(signal.reason().to_string()));
            }
            if Instant::now() >= deadline {
                self.cancel_request(owner, &request_id);
                return Err(BrowserError::TimedOut);
            }
        };
        serde_json::from_value(value).map_err(|error| {
            BrowserError::Failed(format!("invalid {} result: {error}", method.as_str()))
        })
    }

    fn cancel_request(&self, owner: u64, request_id: &str) {
        let outbound = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.pending.remove(request_id).is_some() {
                state.retire(request_id.to_owned(), RetiredRequest::Abandoned);
            }
            state.owners.get(&owner).map(|owner| owner.outbound.clone())
        };
        if let Some(outbound) = outbound {
            let notification = JsonRpcNotification::new(
                "$/cancelRequest".into(),
                serde_json::json!({ "id": request_id }),
            );
            if let Ok(value) = serde_json::to_value(notification) {
                outbound.push(value);
            }
        }
    }

    fn create_owner(&self) -> Result<u64, BrowserError> {
        self.state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?
            .owners
            .iter()
            .find(|(_, owner)| {
                owner.capability.version == 1 && owner.capability.observe && owner.capability.input
            })
            .map(|(connection_id, _)| *connection_id)
            .ok_or(BrowserError::CapabilityUnavailable)
    }

    fn target_owner(
        &self,
        target_id: &BrowserTargetId,
        required: BrowserHostOperation,
    ) -> Result<u64, BrowserError> {
        let state = self
            .state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
        let owner_id = state
            .target_owners
            .get(&target_id.0)
            .copied()
            .ok_or_else(|| BrowserError::TargetUnavailable(target_id.clone()))?;
        let owner = state
            .owners
            .get(&owner_id)
            .ok_or(BrowserError::CapabilityUnavailable)?;
        let supported = match required {
            BrowserHostOperation::Observe => owner.capability.observe,
            BrowserHostOperation::Input => owner.capability.input,
            BrowserHostOperation::Lifecycle => true,
        };
        if supported {
            Ok(owner_id)
        } else {
            Err(BrowserError::CapabilityUnavailable)
        }
    }

    fn register_screenshot(
        &self,
        owner: u64,
        result: BrowserObserveResult,
    ) -> Result<BrowserObservation, BrowserError> {
        let screenshot = result
            .screenshot
            .map(|payload| {
                let max_encoded_len = MAX_RESOURCE_BYTES.div_ceil(3) * 4;
                if payload.mime_type != "image/png"
                    || payload.decoded_length > MAX_RESOURCE_BYTES
                    || payload.data_base64.len() > max_encoded_len
                {
                    return Err(BrowserError::Failed(
                        "browser screenshot payload is invalid or too large".into(),
                    ));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(payload.data_base64)
                    .map_err(|_| {
                        BrowserError::Failed("browser screenshot is not valid base64".into())
                    })?;
                if bytes.len() != payload.decoded_length {
                    return Err(BrowserError::Failed(
                        "browser screenshot decoded length mismatch".into(),
                    ));
                }
                if !bytes.starts_with(PNG_SIGNATURE) {
                    return Err(BrowserError::Failed(
                        "browser screenshot is not a PNG payload".into(),
                    ));
                }
                let state = self
                    .state
                    .lock()
                    .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
                if !state.owners.contains_key(&owner) {
                    return Err(BrowserError::CapabilityUnavailable);
                }
                let metadata = self
                    .resources
                    .lock()
                    .map_err(|_| BrowserError::Failed("resource store lock poisoned".into()))?
                    .create(owner, payload.mime_type, bytes, Duration::from_secs(300))
                    .map_err(|error| {
                        BrowserError::Failed(format!(
                            "browser screenshot resource failed: {error:?}"
                        ))
                    })?;
                drop(state);
                Ok(BrowserMediaResource {
                    resource_id: metadata.resource_id,
                    mime_type: metadata.mime_type,
                    size: metadata.size as u64,
                    digest: metadata.sha256,
                })
            })
            .transpose()?;
        Ok(BrowserObservation {
            target_id: BrowserTargetId(result.target_id),
            url: result.url,
            title: result.title,
            loading: result.loading,
            accessibility_tree: result.accessibility_tree,
            dom_snapshot: result.dom_snapshot,
            screenshot,
        })
    }
}

enum BrowserHostOperation {
    Observe,
    Input,
    Lifecycle,
}

impl BrowserCapability for BrowserHost {
    fn create_target(
        &self,
        request: CreateBrowserTargetRequest,
        cancellation: &CancellationToken,
    ) -> Result<CreateBrowserTargetResult, BrowserError> {
        let owner = self.create_owner()?;
        let result: BrowserCreateResult = self.request(
            owner,
            HostMethod::BrowserCreate,
            &BrowserCreateParams { url: request.url },
            cancellation,
        )?;
        if result.target_id.trim().is_empty() || result.target_id.len() > 256 {
            return Err(BrowserError::Failed(
                "browser host returned an invalid target ID".into(),
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
        if !state.owners.contains_key(&owner) {
            return Err(BrowserError::CapabilityUnavailable);
        }
        let Entry::Vacant(target_owner) = state.target_owners.entry(result.target_id.clone())
        else {
            return Err(BrowserError::Failed(
                "browser host reused a live target ID".into(),
            ));
        };
        target_owner.insert(owner);
        Ok(CreateBrowserTargetResult {
            target_id: BrowserTargetId(result.target_id),
        })
    }

    fn observe(
        &self,
        request: BrowserObserveRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrowserObservation, BrowserError> {
        let owner = self.target_owner(&request.target_id, BrowserHostOperation::Observe)?;
        let expected_target_id = request.target_id.clone();
        let result: BrowserObserveResult = self.request(
            owner,
            HostMethod::BrowserObserve,
            &BrowserObserveParams {
                target_id: request.target_id.0,
                include_accessibility_tree: request.include_accessibility_tree,
                include_dom_snapshot: request.include_dom_snapshot,
                include_screenshot: request.include_screenshot,
            },
            cancellation,
        )?;
        if result.target_id != expected_target_id.0 {
            return Err(BrowserError::Failed(
                "browser host changed target identity".into(),
            ));
        }
        self.register_screenshot(owner, result)
    }

    fn perform(
        &self,
        action: BrowserAction,
        cancellation: &CancellationToken,
    ) -> Result<BrowserActionResult, BrowserError> {
        let target_id = action_target_id(&action).clone();
        let owner = self.target_owner(&target_id, BrowserHostOperation::Input)?;
        let result: BrowserPerformResult = self.request(
            owner,
            HostMethod::BrowserPerform,
            &BrowserPerformParams {
                action: browser_action_dto(action),
            },
            cancellation,
        )?;
        if result.target_id != target_id.0 {
            return Err(BrowserError::Failed(
                "browser host changed target identity".into(),
            ));
        }
        Ok(BrowserActionResult { target_id })
    }

    fn close_target(
        &self,
        target_id: BrowserTargetId,
        cancellation: &CancellationToken,
    ) -> Result<(), BrowserError> {
        let owner = self.target_owner(&target_id, BrowserHostOperation::Lifecycle)?;
        let _: () = self.request(
            owner,
            HostMethod::BrowserClose,
            &BrowserCloseParams {
                target_id: target_id.0.clone(),
            },
            cancellation,
        )?;
        self.state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?
            .target_owners
            .remove(&target_id.0);
        Ok(())
    }
}

fn action_target_id(action: &BrowserAction) -> &BrowserTargetId {
    match action {
        BrowserAction::Navigate { target_id, .. }
        | BrowserAction::Click { target_id, .. }
        | BrowserAction::TypeText { target_id, .. }
        | BrowserAction::Scroll { target_id, .. }
        | BrowserAction::GoBack { target_id }
        | BrowserAction::Reload { target_id } => target_id,
    }
}

fn browser_action_dto(action: BrowserAction) -> BrowserPerformActionDto {
    match action {
        BrowserAction::Navigate { target_id, url } => BrowserPerformActionDto::Navigate {
            target_id: target_id.0,
            url,
        },
        BrowserAction::Click { target_id, target } => BrowserPerformActionDto::Click {
            target_id: target_id.0,
            target: BrowserElementTargetDto {
                node_id: target.node_id,
            },
        },
        BrowserAction::TypeText {
            target_id,
            target,
            text,
        } => BrowserPerformActionDto::TypeText {
            target_id: target_id.0,
            target: match target {
                BrowserTextInputTarget::Element(target) => BrowserTextInputTargetDto::Element {
                    target: BrowserElementTargetDto {
                        node_id: target.node_id,
                    },
                },
                BrowserTextInputTarget::FocusedElement => BrowserTextInputTargetDto::FocusedElement,
            },
            text,
        },
        BrowserAction::Scroll {
            target_id,
            delta_x,
            delta_y,
        } => BrowserPerformActionDto::Scroll {
            target_id: target_id.0,
            delta_x,
            delta_y,
        },
        BrowserAction::GoBack { target_id } => BrowserPerformActionDto::GoBack {
            target_id: target_id.0,
        },
        BrowserAction::Reload { target_id } => BrowserPerformActionDto::Reload {
            target_id: target_id.0,
        },
    }
}

fn host_error(error: JsonRpcError) -> BrowserError {
    if error.message.contains("BrowserTargetUnavailable") {
        BrowserError::Failed("browser target became unavailable".into())
    } else if error.code == -32800 {
        BrowserError::Cancelled(error.message)
    } else {
        BrowserError::Failed(error.message)
    }
}

#[cfg(test)]
#[path = "browser_host_tests.rs"]
mod tests;
