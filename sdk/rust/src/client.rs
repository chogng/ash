use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientRequest;
use external_ext_protocol::ExtensionClientResponse;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::RequestContext;
use serde_json::Value;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::runtime::Writer;

pub use external_ext_protocol::ExtensionConfigurationTarget as ConfigurationTarget;
pub use external_ext_protocol::ExtensionDocumentEdit as DocumentEdit;
pub use external_ext_protocol::ExtensionDocumentSnapshot as DocumentSnapshot;
pub use external_ext_protocol::ExtensionMessageSeverity as MessageSeverity;
pub use external_ext_protocol::ExtensionTextEdit as TextEdit;
pub use external_ext_protocol::ExtensionTextPosition as TextPosition;

struct PendingCall {
    context: RequestContext,
    sender: mpsc::SyncSender<Result<ExtensionClientResult, ExtensionError>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    pending: BTreeMap<u64, PendingCall>,
}

/// Services of the window that invoked this callback. Capture a clone during activation.
/// Every call requires the callback's token; detached work cannot select another window.
#[derive(Clone)]
pub struct Client {
    writer: Writer,
    state: Arc<Mutex<State>>,
    maximum_pending: usize,
}

impl Client {
    pub(crate) fn new(writer: Writer, maximum_pending: usize) -> Self {
        Self {
            writer,
            state: Arc::new(Mutex::new(State::default())),
            maximum_pending,
        }
    }

    /// Calls a granted core service on this invocation's cancellation and deadline.
    pub fn core_service(
        &self,
        request: crate::services::CoreServiceRequest,
        token: &CancellationToken,
    ) -> Result<crate::services::CoreServiceResponse, ExtensionError> {
        let result = self.call(ExtensionClientOperation::CoreService { request }, token)?;
        if let ExtensionClientResult::CoreService { response } = result {
            Ok(response)
        } else {
            Err(unexpected_result())
        }
    }

    pub fn execute_command(
        &self,
        command: impl Into<String>,
        arguments: Vec<Value>,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ExecuteCommand {
                command: command.into(),
                arguments,
            },
            token,
        )? {
            ExtensionClientResult::Command { value, .. } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }

    pub fn open_text_document(
        &self,
        uri: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<DocumentSnapshot, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ReadDocument { uri: uri.into() },
            token,
        )? {
            ExtensionClientResult::Document { document } => Ok(document),
            _ => Err(unexpected_result()),
        }
    }

    pub fn text_documents(
        &self,
        token: &CancellationToken,
    ) -> Result<Vec<DocumentSnapshot>, ExtensionError> {
        match self.call(ExtensionClientOperation::ListDocuments, token)? {
            ExtensionClientResult::Documents { documents } => Ok(documents),
            _ => Err(unexpected_result()),
        }
    }

    pub fn apply_edit(
        &self,
        documents: Vec<DocumentEdit>,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        match self.call(ExtensionClientOperation::ApplyEdit { documents }, token)? {
            ExtensionClientResult::Applied { applied } => Ok(applied),
            _ => Err(unexpected_result()),
        }
    }

    pub fn get_configuration(
        &self,
        section: impl Into<String>,
        resource: Option<String>,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ReadConfiguration {
                section: section.into(),
                resource,
            },
            token,
        )? {
            ExtensionClientResult::Configuration { value } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }

    pub fn update_configuration(
        &self,
        section: impl Into<String>,
        value: Value,
        target: ConfigurationTarget,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::UpdateConfiguration {
                section: section.into(),
                value,
                target,
            },
            token,
        )
    }

    pub fn show_message(
        &self,
        severity: MessageSeverity,
        message: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::ShowMessage {
                message: message.into(),
                severity,
            },
            token,
        )
    }

    pub fn show_quick_pick(
        &self,
        items: Vec<String>,
        placeholder: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<Option<usize>, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ShowQuickPick {
                items,
                placeholder: placeholder.into(),
            },
            token,
        )? {
            ExtensionClientResult::Selection { index } => Ok(index.map(|index| index as usize)),
            _ => Err(unexpected_result()),
        }
    }

    fn done(
        &self,
        operation: ExtensionClientOperation,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        match self.call(operation, token)? {
            ExtensionClientResult::Done => Ok(()),
            _ => Err(unexpected_result()),
        }
    }

    fn call(
        &self,
        operation: ExtensionClientOperation,
        token: &CancellationToken,
    ) -> Result<ExtensionClientResult, ExtensionError> {
        token.check_cancelled()?;
        let context = token.context;
        let (sender, receiver) = mpsc::sync_channel(1);
        let call_id = {
            let mut state = self
                .state
                .lock()
                .expect("client call state is not poisoned");
            if state.pending.len() >= self.maximum_pending {
                return Err(ExtensionError::new(
                    HostErrorCode::QuotaExceeded,
                    "too many pending client calls",
                ));
            }
            state.next_id = state.next_id.checked_add(1).ok_or_else(|| {
                ExtensionError::new(HostErrorCode::QuotaExceeded, "client call IDs exhausted")
            })?;
            let call_id = state.next_id;
            state
                .pending
                .insert(call_id, PendingCall { context, sender });
            call_id
        };
        let request = ExtensionClientRequest {
            context,
            call_id,
            operation,
        };
        if self.writer.write(&request).is_err() {
            self.state
                .lock()
                .expect("client call state is not poisoned")
                .pending
                .remove(&call_id);
            return Err(ExtensionError::new(
                HostErrorCode::Internal,
                "client request transport failed",
            ));
        }
        loop {
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(outcome) => return outcome,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ExtensionError::new(
                        HostErrorCode::Cancelled,
                        "client connection ended",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => token.check_cancelled()?,
            }
        }
    }

    pub(crate) fn respond(
        &self,
        response: ExtensionClientResponse,
    ) -> Result<(), external_ext_protocol::ProtocolError> {
        let mut state = self
            .state
            .lock()
            .expect("client call state is not poisoned");
        let pending = state.pending.get(&response.call_id).ok_or_else(|| {
            external_ext_protocol::ProtocolError::InvalidProtocol("unknown client response".into())
        })?;
        if response.context != pending.context {
            return Err(external_ext_protocol::ProtocolError::InvalidProtocol(
                "client response belongs to a different invocation".into(),
            ));
        }
        let pending = state
            .pending
            .remove(&response.call_id)
            .expect("pending call was checked while locked");
        let _ = pending.sender.send(
            response
                .outcome
                .map_err(|failure| ExtensionError::new(failure.code, failure.message)),
        );
        Ok(())
    }

    pub(crate) fn close(&self) {
        self.state
            .lock()
            .expect("client call state is not poisoned")
            .pending
            .clear();
    }
}

fn unexpected_result() -> ExtensionError {
    ExtensionError::new(
        HostErrorCode::Internal,
        "client returned a result for a different operation",
    )
}
