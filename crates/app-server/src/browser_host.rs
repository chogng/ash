use crate::resource_store::MAX_RESOURCE_BYTES;
use crate::resource_store::ResourceStore;
use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::browser::BrowserCloseParams;
use ash_app_server_protocol::protocol::browser::BrowserCreateParams;
use ash_app_server_protocol::protocol::browser::BrowserCreateResult;
use ash_app_server_protocol::protocol::browser::BrowserElementTargetDto;
use ash_app_server_protocol::protocol::browser::BrowserObserveParams;
use ash_app_server_protocol::protocol::browser::BrowserObserveResult;
use ash_app_server_protocol::protocol::browser::BrowserPerformActionDto;
use ash_app_server_protocol::protocol::browser::BrowserPerformParams;
use ash_app_server_protocol::protocol::browser::BrowserPerformResult;
use ash_app_server_protocol::protocol::browser::BrowserSharingSetParams;
use ash_app_server_protocol::protocol::browser::BrowserTextInputTargetDto;
use ash_app_server_protocol::protocol::common::BrowserCapability as ClientBrowserCapability;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_async_utils::CancellationToken;
use base64::Engine;
use core_api::BrowserAction;
use core_api::BrowserActionResult;
use core_api::BrowserCapability;
use core_api::BrowserError;
use core_api::BrowserMediaResource;
use core_api::BrowserObservation;
use core_api::BrowserObserveRequest;
use core_api::BrowserTargetId;
use core_api::BrowserTextInputTarget;
use core_api::CreateBrowserTargetRequest;
use core_api::CreateBrowserTargetResult;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Default)]
struct BrowserHostState {
    owners: BTreeMap<u64, BrowserHostOwner>,
    owner_revision: u64,
    target_owners: BTreeMap<String, BrowserTargetOwner>,
    shared_targets: BTreeMap<String, (u64, Vec<ash_protocol::ThreadId>)>,
    network_grants: BTreeMap<String, BrowserNetworkGrant>,
}

struct BrowserNetworkGrant {
    owner: u64,
    policy: Arc<crate::network_policy::ExecutionNetworkPolicy>,
    cancellation: ash_async_utils::CancellationSource,
}

/// Keeps request authority alive only while its originating browser tool is executing.
pub(crate) struct BrowserNetworkLease {
    pub(crate) host: BrowserHost,
}

impl Drop for BrowserNetworkLease {
    fn drop(&mut self) {
        let mut state = self
            .host
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(token) = &self.host.network_token
            && let Some(grant) = state.network_grants.remove(token)
        {
            grant.cancellation.cancel();
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
struct BrowserTargetOwner {
    connection_id: u64,
    thread_id: ash_protocol::ThreadId,
}

struct BrowserHostOwner {
    capability: ClientBrowserCapability,
}

/// Routes semantic Core browser requests to the exact capable client connection and target owner.
pub(crate) struct BrowserHost {
    state: Arc<Mutex<BrowserHostState>>,
    resources: Arc<Mutex<ResourceStore>>,
    pub(crate) clients: Arc<crate::client_host::ClientHost>,
    owner: Option<u64>,
    thread_id: Option<ash_protocol::ThreadId>,
    network_token: Option<String>,
}

impl BrowserHost {
    pub(crate) fn new(
        resources: Arc<Mutex<ResourceStore>>,
        clients: Arc<crate::client_host::ClientHost>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(BrowserHostState::default())),
            resources,
            clients,
            owner: None,
            thread_id: None,
            network_token: None,
        }
    }

    pub(crate) fn for_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> Result<Self, BrowserError> {
        let owner = self
            .clients
            .binding(thread, turn)
            .map_err(browser_host_error)?
            .ok_or(BrowserError::CapabilityUnavailable)?
            .connection_id;
        let scoped = Self {
            state: Arc::clone(&self.state),
            resources: Arc::clone(&self.resources),
            clients: Arc::clone(&self.clients),
            owner: Some(owner),
            thread_id: Some(thread.clone()),
            network_token: None,
        };
        scoped.create_owner()?;
        Ok(scoped)
    }

    pub(crate) fn with_network_policy(
        mut self,
        policy: crate::network_policy::ExecutionNetworkPolicy,
        cancellation: &CancellationToken,
    ) -> Result<BrowserNetworkLease, BrowserError> {
        let owner = self.create_owner()?;
        let source = cancellation.child_source();
        let token = format!("browser-network-{}", source.id());
        let mut state = self
            .state
            .lock()
            .map_err(|_| BrowserError::CapabilityUnavailable)?;
        if !state.owners.contains_key(&owner) || state.network_grants.len() >= 128 {
            return Err(BrowserError::CapabilityUnavailable);
        }
        state.network_grants.insert(
            token.clone(),
            BrowserNetworkGrant {
                owner,
                policy: Arc::new(policy),
                cancellation: source,
            },
        );
        drop(state);
        self.network_token = Some(token);
        Ok(BrowserNetworkLease { host: self })
    }

    pub(crate) fn authorize_network(
        &self,
        owner: u64,
        params: &ash_app_server_protocol::protocol::browser::BrowserNetworkAuthorizeParams,
    ) -> bool {
        let grant = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .network_grants
                .get(&params.network_token)
                .filter(|grant| grant.owner == owner)
                .map(|grant| (Arc::clone(&grant.policy), grant.cancellation.token()))
        };
        let Some((policy, cancellation)) = grant else {
            return false;
        };
        let Ok(url) = url::Url::parse(&params.url) else {
            return false;
        };
        if !url.username().is_empty() || url.password().is_some() {
            return false;
        }
        let protocol = match url.scheme() {
            "http" => network_proxy::NetworkProtocol::Http,
            "https" => network_proxy::NetworkProtocol::HttpsConnect,
            _ => return false,
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        let Some(port) = url.port_or_known_default() else {
            return false;
        };
        let Ok(target) =
            network_proxy::NetworkRequest::new(protocol, host.trim_matches(['[', ']']), port)
        else {
            return false;
        };
        cancellation.check().is_ok()
            && matches!(
                policy.decide_blocking(target.with_method(&params.method), &cancellation),
                network_proxy::NetworkDecision::Allow
            )
            && cancellation.check().is_ok()
    }

    pub(crate) fn register(
        &self,
        connection_id: u64,
        capability: ClientBrowserCapability,
        outbound: NotificationQueue,
    ) {
        self.unregister(connection_id);
        self.clients
            .register(connection_id, false, outbound.clone());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .owners
            .insert(connection_id, BrowserHostOwner { capability });
        state.owner_revision = state.owner_revision.wrapping_add(1);
    }

    pub(crate) fn unregister(&self, connection_id: u64) {
        self.clients.unregister(connection_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.owners.remove(&connection_id).is_some() {
            state.owner_revision = state.owner_revision.wrapping_add(1);
        }
        state
            .target_owners
            .retain(|_, owner| owner.connection_id != connection_id);
        state.network_grants.retain(|_, grant| {
            if grant.owner == connection_id {
                grant.cancellation.cancel();
                return false;
            }
            true
        });
        state
            .shared_targets
            .retain(|_, (owner, _)| *owner != connection_id);
    }

    pub(crate) fn set_sharing(
        &self,
        connection_id: u64,
        params: &BrowserSharingSetParams,
        cancellation: &CancellationToken,
    ) -> Result<(), BrowserError> {
        let threads = params
            .thread_ids
            .iter()
            .map(|id| ash_protocol::ThreadId::new(id.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| BrowserError::Failed("invalid sharing audience".into()))?;
        {
            let state = self
                .state
                .lock()
                .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
            if !state.owners.contains_key(&connection_id)
                || state.target_owners.contains_key(&params.target_id)
                || state
                    .shared_targets
                    .get(&params.target_id)
                    .is_some_and(|(owner, _)| *owner != connection_id)
            {
                return Err(BrowserError::CapabilityUnavailable);
            }
        }
        // Main verifies the user page and revokes its CDP leases before the backend publishes the audience.
        self.request::<_, ()>(
            connection_id,
            HostMethod::BrowserSharingSet,
            params,
            cancellation,
        )?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?;
        if !state.owners.contains_key(&connection_id) {
            return Err(BrowserError::CapabilityUnavailable);
        }
        if threads.is_empty() {
            state.shared_targets.remove(&params.target_id);
        } else {
            state
                .shared_targets
                .insert(params.target_id.clone(), (connection_id, threads));
        }
        Ok(())
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

    fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        owner: u64,
        method: HostMethod,
        params: &P,
        cancellation: &CancellationToken,
    ) -> Result<R, BrowserError> {
        self.clients
            .request(owner, method, params, cancellation)
            .map_err(browser_host_error)
    }

    fn create_owner(&self) -> Result<u64, BrowserError> {
        self.thread_id()?;
        let selected = self.owner.ok_or(BrowserError::CapabilityUnavailable)?;
        self.state
            .lock()
            .map_err(|_| BrowserError::Failed("browser host state lock poisoned".into()))?
            .owners
            .get(&selected)
            .filter(|owner| {
                owner.capability.version == 3 && owner.capability.observe && owner.capability.input
            })
            .map(|_| selected)
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
        let thread = self.thread_id()?;
        let owner_id = if let Some(target_owner) = state.target_owners.get(&target_id.0) {
            if thread != &target_owner.thread_id {
                return Err(BrowserError::CapabilityUnavailable);
            }
            target_owner.connection_id
        } else {
            if !matches!(required, BrowserHostOperation::Observe) {
                return Err(BrowserError::TargetUnavailable(target_id.clone()));
            }
            let (owner, _) = state
                .shared_targets
                .get(&target_id.0)
                .filter(|(_, audience)| audience.contains(thread))
                .ok_or_else(|| BrowserError::TargetUnavailable(target_id.clone()))?;
            *owner
        };
        let owner = state
            .owners
            .get(&owner_id)
            .ok_or(BrowserError::CapabilityUnavailable)?;
        if self.owner != Some(owner_id) {
            return Err(BrowserError::CapabilityUnavailable);
        }
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

    fn thread_id(&self) -> Result<&ash_protocol::ThreadId, BrowserError> {
        self.thread_id
            .as_ref()
            .ok_or(BrowserError::CapabilityUnavailable)
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
            &BrowserCreateParams {
                thread_id: self.thread_id()?.to_string(),
                network_token: self.network_token.clone(),
                url: request.url,
            },
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
        target_owner.insert(BrowserTargetOwner {
            connection_id: owner,
            thread_id: self.thread_id()?.clone(),
        });
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
                thread_id: self.thread_id()?.to_string(),
                network_token: self.network_token.clone(),
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
                thread_id: self.thread_id()?.to_string(),
                network_token: self.network_token.clone(),
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
                thread_id: self.thread_id()?.to_string(),
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

fn browser_host_error(error: crate::client_host::ClientHostError) -> BrowserError {
    match error {
        crate::client_host::ClientHostError::CapabilityUnavailable => {
            BrowserError::CapabilityUnavailable
        }
        crate::client_host::ClientHostError::Cancelled(message) => BrowserError::Cancelled(message),
        crate::client_host::ClientHostError::TimedOut => BrowserError::TimedOut,
        crate::client_host::ClientHostError::Failed(message) => BrowserError::Failed(message),
    }
}

#[cfg(test)]
#[path = "browser_host_tests.rs"]
mod tests;
