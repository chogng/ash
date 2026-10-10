//! Activation-scoped core services. Calls never select a window or backend connection.

use crate::ExtensionError;
use crate::HostErrorCode;
use crate::runtime::Writer;
use external_ext_protocol::ExtensionBackgroundClientRequest;
use external_ext_protocol::ExtensionBackgroundClientResponse;
use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::HostEventContext;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

pub use external_ext_protocol::services::CoreHttpMethod;
pub use external_ext_protocol::services::CoreServiceRequest;
pub use external_ext_protocol::services::CoreServiceResponse;

type Reply = Result<CoreServiceResponse, ExtensionError>;
#[derive(Default)]
struct State {
    next_id: u64,
    closed: bool,
    pending: BTreeMap<u64, (HostEventContext, mpsc::SyncSender<Reply>)>,
}

/// A profile host grants only the closed service contract and its namespace.
/// Clones share the activation fence and are retired together when the runtime closes.
#[derive(Clone)]
pub struct Services {
    writer: Writer,
    state: Arc<Mutex<State>>,
    context: Option<HostEventContext>,
    maximum_pending: usize,
}

impl Services {
    pub(crate) fn new(writer: Writer, maximum_pending: usize) -> Self {
        Self {
            writer,
            state: Arc::new(Mutex::new(State::default())),
            context: None,
            maximum_pending,
        }
    }
    pub(crate) fn bound(&self, context: HostEventContext) -> Self {
        Self {
            context: Some(context),
            ..self.clone()
        }
    }
    pub fn call(&self, request: CoreServiceRequest) -> Reply {
        let context = self.context.ok_or_else(unavailable)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let (call_id, written) = {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            if state.closed || state.pending.len() >= self.maximum_pending {
                return Err(unavailable());
            }
            state.next_id = state.next_id.checked_add(1).ok_or_else(unavailable)?;
            let id = state.next_id;
            state.pending.insert(id, (context, sender));
            // Reserve and emit under one lock so concurrent background callers
            // preserve the host's strictly increasing call ID fence.
            let written = self
                .writer
                .write(&ExtensionBackgroundClientRequest {
                    context,
                    call_id: id,
                    operation: ExtensionClientOperation::CoreService { request },
                })
                .map_err(|_| unavailable());
            (id, written)
        };
        let outcome = written.and_then(|_| {
            receiver
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| unavailable())?
        });
        self.state
            .lock()
            .map_err(|_| unavailable())?
            .pending
            .remove(&call_id);
        outcome
    }
    pub(crate) fn respond(
        &self,
        response: ExtensionBackgroundClientResponse,
    ) -> Result<(), external_ext_protocol::ProtocolError> {
        let mut state = self.state.lock().map_err(|_| {
            external_ext_protocol::ProtocolError::InvalidProtocol(
                "core service state poisoned".into(),
            )
        })?;
        let Some((context, sender)) = state.pending.remove(&response.call_id) else {
            return Ok(());
        };
        if context != response.context {
            return Err(external_ext_protocol::ProtocolError::InvalidProtocol(
                "core service response has stale activation".into(),
            ));
        }
        let outcome = response
            .outcome
            .map_err(|error| ExtensionError::new(error.code, error.message))
            .and_then(|result| match result {
                ExtensionClientResult::CoreService { response } => Ok(response),
                _ => Err(unavailable()),
            });
        let _ = sender.send(outcome);
        Ok(())
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending.clear();
        }
    }
}
fn unavailable() -> ExtensionError {
    ExtensionError::new(HostErrorCode::Internal, "core service is unavailable")
}
