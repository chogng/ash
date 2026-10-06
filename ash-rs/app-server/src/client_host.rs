use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use ash_app_server_protocol::protocol::text_document::TextDocumentTurnFinished;
use ash_app_server_protocol::protocol::text_document::TextDocumentTurnOutcome;
use ash_app_server_protocol::rpc::JsonRpcError;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_protocol::rpc::JsonRpcNotification;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcResponse;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use core_api::TurnReceipt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CANCELLATION_POLL: Duration = Duration::from_millis(50);
const RETIRED_REQUEST_LIMIT: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ClientHostError {
    CapabilityUnavailable,
    Cancelled(String),
    TimedOut,
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TextDocumentMode {
    Client,
    FileSystem,
}

#[derive(Clone, Copy)]
pub(crate) struct TurnHostBinding {
    pub(crate) connection_id: u64,
    pub(crate) text_documents: bool,
}

#[derive(Default)]
struct ClientHostState {
    owners: BTreeMap<u64, ClientHostOwner>,
    pending: BTreeMap<String, PendingRequest>,
    retired: BTreeMap<String, RetiredRequest>,
    retired_order: VecDeque<String>,
    next_request_id: u64,
}

struct ClientHostOwner {
    outbound: NotificationQueue,
    text_documents: bool,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RetiredRequest {
    Completed,
    Abandoned,
}

impl ClientHostState {
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

struct PendingRequest {
    connection_id: u64,
    sender: mpsc::SyncSender<Result<Value, ClientHostError>>,
}

// A response removes the registration before waking the caller. Every other exit must retire
// it so late responses remain valid and the client receives cancellation exactly once.
struct PendingRequestGuard<'a> {
    host: &'a ClientHost,
    owner: u64,
    request_id: &'a str,
}

impl Drop for PendingRequestGuard<'_> {
    fn drop(&mut self) {
        self.host.cancel_request(self.owner, self.request_id);
    }
}

/// Shared connection owner for server requests and the initiating Turn binding.
/// Browser and text-document domains keep their own state and consume this transport boundary.
#[derive(Default)]
pub(crate) struct ClientHost {
    state: Mutex<ClientHostState>,
    turns: Mutex<BTreeMap<(ash_protocol::ThreadId, ash_protocol::TurnId), Option<TurnHostBinding>>>,
}

impl ClientHost {
    pub(crate) fn register(
        &self,
        connection_id: u64,
        text_documents: bool,
        outbound: NotificationQueue,
    ) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owners
            .insert(
                connection_id,
                ClientHostOwner {
                    outbound,
                    text_documents,
                },
            );
    }

    pub(crate) fn unregister(&self, connection_id: u64) {
        let pending = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.owners.remove(&connection_id);
            let ids = state
                .pending
                .iter()
                .filter(|(_, request)| request.connection_id == connection_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| {
                    state.retire(id.clone(), RetiredRequest::Abandoned);
                    state.pending.remove(&id)
                })
                .collect::<Vec<_>>()
        };
        // Bindings survive disconnect until the Turn terminates. Removing them would silently
        // change an editor execution into disk execution when the next tool is scheduled.
        for request in pending {
            let _ = request
                .sender
                .send(Err(ClientHostError::CapabilityUnavailable));
        }
    }

    pub(crate) fn submit_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        connection: Option<u64>,
        document_mode: TextDocumentMode,
        submit: impl FnOnce() -> Result<TurnReceipt, CoreError>,
    ) -> Result<TurnReceipt, CoreError> {
        // Tool workers cannot resolve a host before the receipt is bound to its originating client.
        let mut turns = self
            .turns
            .lock()
            .map_err(|_| CoreError::Execution("client Turn binding lock poisoned".into()))?;
        let binding = connection
            .map(|connection_id| -> Result<TurnHostBinding, CoreError> {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| CoreError::Execution("client host state lock poisoned".into()))?;
                let owner = state.owners.get(&connection_id).ok_or_else(|| {
                    CoreError::Execution("initiating client is unavailable".into())
                })?;
                Ok(TurnHostBinding {
                    connection_id,
                    text_documents: owner.text_documents
                        && document_mode == TextDocumentMode::Client,
                })
            })
            .transpose()?;
        let receipt = submit()?;
        turns
            .entry((thread.clone(), receipt.turn_id.clone()))
            .or_insert(binding);
        Ok(receipt)
    }

    pub(crate) fn finish_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
        outcome: TextDocumentTurnOutcome,
    ) {
        let binding = self
            .turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&(thread.clone(), turn.clone()))
            .flatten();
        if let Some(binding) = binding.filter(|binding| binding.text_documents) {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(owner) = state.owners.get(&binding.connection_id) {
                let notification = JsonRpcNotification::new(
                    ServerNotificationMethod::TextDocumentTurnFinished
                        .as_str()
                        .to_owned(),
                    serde_json::to_value(TextDocumentTurnFinished {
                        thread_id: thread.clone(),
                        turn_id: turn.clone(),
                        outcome,
                    })
                    .expect("text document Turn result serializes"),
                );
                owner
                    .outbound
                    .push(serde_json::to_value(notification).expect("notification serializes"));
            }
        }
    }

    pub(crate) fn binding(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> Result<Option<TurnHostBinding>, ClientHostError> {
        Ok(self
            .turns
            .lock()
            .map_err(|_| ClientHostError::Failed("client Turn binding lock poisoned".into()))?
            .get(&(thread.clone(), turn.clone()))
            .copied()
            .ok_or(ClientHostError::CapabilityUnavailable)?)
    }

    pub(crate) fn submit_agent_turn(
        &self,
        parent_thread: &ash_protocol::ThreadId,
        parent_turn: &ash_protocol::TurnId,
        child_thread: &ash_protocol::ThreadId,
        replayed_turn: Option<&ash_protocol::TurnId>,
        document_mode: TextDocumentMode,
        submit: impl FnOnce() -> Result<ash_core::StartTurnResult, CoreError>,
    ) -> Result<ash_core::StartTurnResult, CoreError> {
        let mut turns = self
            .turns
            .lock()
            .map_err(|_| CoreError::Execution("client Turn binding lock poisoned".into()))?;
        let mut binding = match replayed_turn
            .and_then(|turn| turns.get(&(child_thread.clone(), turn.clone())))
        {
            Some(binding) => *binding,
            None => match document_mode {
                TextDocumentMode::Client => *turns
                    .get(&(parent_thread.clone(), parent_turn.clone()))
                    .ok_or_else(|| {
                        CoreError::Execution("parent Turn execution context is unavailable".into())
                    })?,
                TextDocumentMode::FileSystem => turns
                    .get(&(parent_thread.clone(), parent_turn.clone()))
                    .copied()
                    .flatten(),
            },
        };
        if document_mode == TextDocumentMode::FileSystem {
            if let Some(binding) = &mut binding {
                binding.text_documents = false;
            }
        }
        // Keep selection and admission under the same gate: child workers may start immediately.
        let receipt = submit()?;
        turns
            .entry((child_thread.clone(), receipt.turn_id.clone()))
            .or_insert(binding);
        Ok(receipt)
    }

    pub(crate) fn is_connected(&self, owner: u64) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owners
            .contains_key(&owner)
    }

    pub(crate) fn handle_response(
        &self,
        connection_id: u64,
        message: Value,
    ) -> Result<bool, String> {
        let Some(request_id) = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|request_id| request_id.starts_with("client-host:"))
            .map(str::to_owned)
        else {
            return Ok(false);
        };
        let response = serde_json::from_value::<JsonRpcResponse<Value, JsonRpcError>>(message)
            .map_err(|error| format!("invalid client host response: {error}"))?;
        let pending = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "client host state lock poisoned".to_string())?;
            let Some(pending) = state.pending.get(&request_id) else {
                return match state.retired.get(&request_id) {
                    Some(RetiredRequest::Abandoned) => Ok(true),
                    Some(RetiredRequest::Completed) => {
                        Err(format!("duplicate client host response: {request_id}"))
                    }
                    None => Err(format!(
                        "client host response has unknown request ID: {request_id}"
                    )),
                };
            };
            if pending.connection_id != connection_id {
                return Err("client host response came from a non-owning connection".into());
            }
            let pending = state
                .pending
                .remove(&request_id)
                .expect("client host pending request was checked while locked");
            state.retire(request_id.clone(), RetiredRequest::Completed);
            pending
        };
        let result = match response {
            JsonRpcResponse::Success(success) => Ok(success.result),
            JsonRpcResponse::Failure(failure) => Err(remote_error(failure.error)),
        };
        let _ = pending.sender.send(result);
        Ok(true)
    }

    pub(crate) fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        owner: u64,
        method: HostMethod,
        params: &P,
        cancellation: &CancellationToken,
    ) -> Result<R, ClientHostError> {
        self.request_with_timeout(owner, method, params, cancellation, REQUEST_TIMEOUT)
    }

    pub(crate) fn request_with_timeout<P: Serialize, R: DeserializeOwned>(
        &self,
        owner: u64,
        method: HostMethod,
        params: &P,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<R, ClientHostError> {
        if timeout.is_zero() {
            return Err(ClientHostError::TimedOut);
        }
        cancellation
            .check()
            .map_err(|signal| ClientHostError::Cancelled(signal.reason().to_string()))?;
        let params = serde_json::to_value(params)
            .map_err(|error| ClientHostError::Failed(error.to_string()))?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let (request_id, outbound) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| ClientHostError::Failed("client host state lock poisoned".into()))?;
            let outbound = state
                .owners
                .get(&owner)
                .map(|owner| owner.outbound.clone())
                .ok_or(ClientHostError::CapabilityUnavailable)?;
            state.next_request_id = state.next_request_id.checked_add(1).ok_or_else(|| {
                ClientHostError::Failed("client host request ID exhausted".into())
            })?;
            let request_id = format!("client-host:{owner}:{}", state.next_request_id);
            state.pending.insert(
                request_id.clone(),
                PendingRequest {
                    connection_id: owner,
                    sender,
                },
            );
            (request_id, outbound)
        };
        let _registration = PendingRequestGuard {
            host: self,
            owner,
            request_id: &request_id,
        };
        let request = JsonRpcRequest::new(
            JsonRpcId::String(request_id.clone()),
            method.as_str().into(),
            params,
        );
        outbound.push(
            serde_json::to_value(request)
                .map_err(|error| ClientHostError::Failed(error.to_string()))?,
        );

        let deadline = Instant::now() + timeout.min(REQUEST_TIMEOUT);
        let value = loop {
            match receiver.recv_timeout(CANCELLATION_POLL.min(deadline.saturating_duration_since(Instant::now()))) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(ClientHostError::CapabilityUnavailable)?;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Err(signal) = cancellation.check() {
                return Err(ClientHostError::Cancelled(signal.reason().to_string()));
            }
            if Instant::now() >= deadline {
                return Err(ClientHostError::TimedOut);
            }
        };
        serde_json::from_value(value).map_err(|error| {
            ClientHostError::Failed(format!("invalid {} result: {error}", method.as_str()))
        })
    }

    fn cancel_request(&self, owner: u64, request_id: &str) {
        let outbound = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.pending.remove(request_id).is_none() {
                return;
            }
            state.retire(request_id.to_owned(), RetiredRequest::Abandoned);
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
}

fn remote_error(error: JsonRpcError) -> ClientHostError {
    if error.code == -32800 {
        ClientHostError::Cancelled(error.message)
    } else {
        ClientHostError::Failed(error.message)
    }
}

#[cfg(test)]
#[path = "client_host_tests.rs"]
mod tests;
