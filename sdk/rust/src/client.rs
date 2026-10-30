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
pub use external_ext_protocol::ExtensionDebugSessionOptions as DebugSessionOptions;
pub use external_ext_protocol::ExtensionDiagnosticEntry as DiagnosticEntry;
pub use external_ext_protocol::ExtensionDocumentEdit as DocumentEdit;
pub use external_ext_protocol::ExtensionDocumentSnapshot as DocumentSnapshot;
pub use external_ext_protocol::ExtensionMessageSeverity as MessageSeverity;
pub use external_ext_protocol::ExtensionProgressOptions as ProgressOptions;
pub use external_ext_protocol::ExtensionQuickPickItem as QuickPickItem;
pub use external_ext_protocol::ExtensionTextEdit as TextEdit;
pub use external_ext_protocol::ExtensionTextPosition as TextPosition;

struct PendingCall {
    context: RequestContext,
    sender: Option<mpsc::SyncSender<Result<ExtensionClientResult, ExtensionError>>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    closed: bool,
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
    /// Replaces this activation's diagnostic collection, bound to observed document versions.
    pub fn set_diagnostics(
        &self,
        collection: String,
        entries: Vec<DiagnosticEntry>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::SetDiagnostics {
                collection,
                entries,
                merge: None,
            },
            token,
        )
    }

    /// Updates listed resources without clearing unrelated diagnostics in the collection.
    pub fn update_diagnostics(
        &self,
        collection: String,
        entries: Vec<DiagnosticEntry>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::SetDiagnostics {
                collection,
                entries,
                merge: Some(true),
            },
            token,
        )
    }

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

    /// Reads one ordinary value in the host-bound profile namespace; no local cache.
    pub fn storage_get(
        &self,
        key: String,
        token: &CancellationToken,
    ) -> Result<Option<Value>, ExtensionError> {
        if let crate::services::CoreServiceResponse::StorageValue { value, found } = self
            .core_service(
                crate::services::CoreServiceRequest::StorageGet { key },
                token,
            )?
        {
            Ok(found.then_some(value))
        } else {
            Err(unexpected_result())
        }
    }
    /// Sets one ordinary value, or deletes it with None. Does not replay an uncertain write.
    pub fn storage_update(
        &self,
        key: String,
        value: Option<Value>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        let request = match value {
            Some(value) => crate::services::CoreServiceRequest::StorageSet { key, value },
            None => crate::services::CoreServiceRequest::StorageDelete { key },
        };
        if let crate::services::CoreServiceResponse::StorageUpdated =
            self.core_service(request, token)?
        {
            Ok(())
        } else {
            Err(unexpected_result())
        }
    }

    /// Loads bytes from this extension's private profile namespace, never a product credential key.
    pub fn secret_load(
        &self,
        key: String,
        token: &CancellationToken,
    ) -> Result<Option<Vec<u8>>, ExtensionError> {
        if let crate::services::CoreServiceResponse::SecretLoaded { value } = self.core_service(
            crate::services::CoreServiceRequest::SecretLoad { key },
            token,
        )? {
            Ok(value)
        } else {
            Err(unexpected_result())
        }
    }
    /// Stores private bytes without replaying an uncertain write.
    pub fn secret_store(
        &self,
        key: String,
        value: Vec<u8>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        if let crate::services::CoreServiceResponse::SecretStored = self.core_service(
            crate::services::CoreServiceRequest::SecretStore { key, value },
            token,
        )? {
            Ok(())
        } else {
            Err(unexpected_result())
        }
    }
    /// Deletes one private key; returns false when it was already absent.
    pub fn secret_delete(
        &self,
        key: String,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        if let crate::services::CoreServiceResponse::SecretDeleted { deleted } = self.core_service(
            crate::services::CoreServiceRequest::SecretDelete { key },
            token,
        )? {
            Ok(deleted)
        } else {
            Err(unexpected_result())
        }
    }
    /// Calls one package-declared capability without exposing the host connection.
    pub fn request_backend(
        &self,
        capability: impl Into<String>,
        method: impl Into<String>,
        params: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        self.value(
            ExtensionClientOperation::BackendRequest {
                capability: capability.into(),
                method: method.into(),
                params,
                progress: None,
            },
            token,
        )
    }

    pub fn request_backend_with_progress(
        &self,
        capability: impl Into<String>,
        method: impl Into<String>,
        params: Value,
        progress: ProgressOptions,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        self.value(
            ExtensionClientOperation::BackendRequest {
                capability: capability.into(),
                method: method.into(),
                params,
                progress: Some(progress),
            },
            token,
        )
    }

    pub fn backend_state(
        &self,
        capability: impl Into<String>,
        after: u64,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        self.value(
            ExtensionClientOperation::BackendState {
                capability: capability.into(),
                after,
                wait_for_change: None,
            },
            token,
        )
    }

    pub fn editor_operation(
        &self,
        payload: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        self.value(ExtensionClientOperation::EditorOperation { payload }, token)
    }

    pub fn update_source_control(
        &self,
        registration_id: impl Into<String>,
        revision: u64,
        providers: Vec<Value>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::ScmUpdate {
                registration_id: registration_id.into(),
                revision,
                providers,
            },
            token,
        )
    }

    fn value(
        &self,
        operation: ExtensionClientOperation,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        match self.call(operation, token)? {
            ExtensionClientResult::Value { value } => Ok(value),
            _ => Err(unexpected_result()),
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

    /// Reads bytes through the initiating client's authorized resource provider.
    pub fn read_resource_file(
        &self,
        uri: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<Vec<u8>, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ReadResourceFile { uri: uri.into() },
            token,
        )? {
            ExtensionClientResult::ResourceFile { bytes } => Ok(bytes),
            _ => Err(unexpected_result()),
        }
    }

    /// Returns provider file type, byte size and modification time in Unix milliseconds.
    pub fn stat_resource(
        &self,
        uri: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<(u8, u64, u64), ExtensionError> {
        match self.call(
            ExtensionClientOperation::StatResource { uri: uri.into() },
            token,
        )? {
            ExtensionClientResult::ResourceStat {
                file_type,
                size,
                mtime,
            } => Ok((file_type, size, mtime)),
            _ => Err(unexpected_result()),
        }
    }

    /// Lists child names and provider file types through the same client authorization.
    pub fn read_resource_directory(
        &self,
        uri: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<Vec<(String, u8)>, ExtensionError> {
        match self.call(
            ExtensionClientOperation::ReadResourceDirectory { uri: uri.into() },
            token,
        )? {
            ExtensionClientResult::ResourceDirectory { entries } => Ok(entries),
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

    pub fn inspect_configuration(
        &self,
        section: impl Into<String>,
        resource: Option<String>,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        match self.call(
            ExtensionClientOperation::InspectConfiguration {
                section: section.into(),
                resource,
            },
            token,
        )? {
            ExtensionClientResult::Configuration { value } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }
    pub fn reset_configuration(
        &self,
        section: impl Into<String>,
        target: ConfigurationTarget,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        self.done(
            ExtensionClientOperation::ResetConfiguration {
                section: section.into(),
                target,
            },
            token,
        )
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
                items: Vec::new(),
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
        self.show_quick_pick_items(
            items
                .into_iter()
                .map(|label| QuickPickItem {
                    label,
                    description: None,
                    detail: None,
                })
                .collect(),
            placeholder,
            token,
        )
    }

    /// Displays structured items and validates the returned index against this exact request.
    pub fn show_quick_pick_items(
        &self,
        items: Vec<QuickPickItem>,
        placeholder: impl Into<String>,
        token: &CancellationToken,
    ) -> Result<Option<usize>, ExtensionError> {
        if items.is_empty() {
            return Ok(None);
        }
        let count = items.len();
        match self.call(
            ExtensionClientOperation::ShowQuickPick {
                items,
                placeholder: placeholder.into(),
            },
            token,
        )? {
            ExtensionClientResult::Selection { index } => match index.map(|index| index as usize) {
                Some(index) if index >= count => Err(unexpected_result()),
                value => Ok(value),
            },
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
        let (call_id, written) = {
            let mut state = self
                .state
                .lock()
                .expect("client call state is not poisoned");
            if state.closed {
                return Err(ExtensionError::new(
                    HostErrorCode::Cancelled,
                    "client connection ended",
                ));
            }
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
            state.pending.insert(
                call_id,
                PendingCall {
                    context,
                    sender: Some(sender),
                },
            );
            // Cloned tokens can issue concurrent calls for the same invocation. Allocation
            // and emission must preserve the host's strictly increasing call-ID fence.
            let written = self.writer.write(&ExtensionClientRequest {
                context,
                call_id,
                operation,
            });
            (call_id, written)
        };
        if written.is_err() {
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
        if let Some(sender) = pending.sender {
            let _ = sender.send(
                response
                    .outcome
                    .map_err(|failure| ExtensionError::new(failure.code, failure.message)),
            );
        }
        Ok(())
    }

    pub(crate) fn reopen(&self) {
        // A later activation shares the transport's monotonically increasing IDs and
        // late-reply correlations; only its ability to admit fresh calls is reopened.
        self.state
            .lock()
            .expect("client call state is not poisoned")
            .closed = false;
    }

    pub(crate) fn close(&self) {
        let mut state = self
            .state
            .lock()
            .expect("client call state is not poisoned");
        state.closed = true;
        // Drop waiters before joining callbacks, but retain each bounded correlation until
        // its host reply arrives. A normal shutdown must not turn that late reply fatal.
        for call in state.pending.values_mut() {
            call.sender.take();
        }
    }
}

fn unexpected_result() -> ExtensionError {
    ExtensionError::new(
        HostErrorCode::Internal,
        "client returned a result for a different operation",
    )
}

/// Client services bound by the host to this activation's window. Unlike invocation calls,
/// these can publish subscription updates after a foreground callback returns. Retirement
/// closes all clones and the host cancels outstanding calls on disconnect.
#[derive(Clone)]
pub struct BackgroundClient {
    services: crate::services::Services,
}
impl BackgroundClient {
    /// Creates and optionally starts a command in an activation-owned integrated terminal.
    pub fn create_terminal(
        &self,
        name: String,
        cwd: Option<String>,
        env: BTreeMap<String, Option<String>>,
        append_env: BTreeMap<String, String>,
        command: Option<String>,
    ) -> Result<crate::terminal::TerminalHandle, ExtensionError> {
        serde_json::from_value(self.value(ExtensionClientOperation::CreateTerminal {
            name,
            cwd,
            env,
            append_env: (!append_env.is_empty()).then_some(append_env),
            command,
        })?)
        .map_err(|_| unexpected_result())
    }

    /// Reads only this activation's terminal. Output retention is bounded by the terminal bridge.
    pub fn read_terminal(
        &self,
        terminal_id: String,
        after_sequence: u64,
    ) -> Result<crate::terminal::TerminalRead, ExtensionError> {
        serde_json::from_value(self.value(ExtensionClientOperation::ReadTerminal {
            terminal_id,
            after_sequence,
        })?)
        .map_err(|_| unexpected_result())
    }

    /// Closes a terminal and its shell through the terminal owner; other activations cannot use its ID.
    pub fn dispose_terminal(&self, terminal_id: String) -> Result<(), ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::DisposeTerminal { terminal_id })?
        {
            ExtensionClientResult::Done => Ok(()),
            _ => Err(unexpected_result()),
        }
    }
    /// Uses the activation's bound window; retirement cancels an in-flight launch.
    pub fn start_debugging(
        &self,
        folder: Option<String>,
        configuration: Value,
        options: Option<DebugSessionOptions>,
    ) -> Result<bool, ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::StartDebugging {
                folder,
                configuration,
                options,
            })? {
            ExtensionClientResult::DebugStarted { started } => Ok(started),
            _ => Err(unexpected_result()),
        }
    }
    /// Retires activation-owned background calls before joining subscription tasks.
    pub fn close(&self) {
        self.services.close();
    }
    pub fn request_backend(
        &self,
        capability: impl Into<String>,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ExtensionError> {
        self.value(ExtensionClientOperation::BackendRequest {
            capability: capability.into(),
            method: method.into(),
            params,
            progress: None,
        })
    }

    pub fn new(services: crate::services::Services) -> Self {
        Self { services }
    }
    pub fn show_message(
        &self,
        severity: MessageSeverity,
        message: impl Into<String>,
    ) -> Result<(), ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::ShowMessage {
                message: message.into(),
                severity,
                items: Vec::new(),
            })? {
            ExtensionClientResult::Done => Ok(()),
            _ => Err(unexpected_result()),
        }
    }
    pub fn backend_state(
        &self,
        capability: impl Into<String>,
        after: u64,
    ) -> Result<Value, ExtensionError> {
        self.value(ExtensionClientOperation::BackendState {
            capability: capability.into(),
            after,
            wait_for_change: None,
        })
    }
    /// Waits for admitted backend/editor changes, renewing before the service deadline.
    /// Closing the activation interrupts the wait before background tasks are joined.
    pub fn wait_for_backend_state(
        &self,
        capability: impl Into<String>,
        after: u64,
    ) -> Result<Value, ExtensionError> {
        self.value(ExtensionClientOperation::BackendState {
            capability: capability.into(),
            after,
            wait_for_change: Some(true),
        })
    }
    pub fn editor_operation(&self, payload: Value) -> Result<Value, ExtensionError> {
        self.value(ExtensionClientOperation::EditorOperation { payload })
    }
    pub fn inspect_configuration(
        &self,
        section: impl Into<String>,
        resource: Option<String>,
    ) -> Result<Value, ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::InspectConfiguration {
                section: section.into(),
                resource,
            })? {
            ExtensionClientResult::Configuration { value } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }
    pub fn reset_configuration(
        &self,
        section: impl Into<String>,
        target: ConfigurationTarget,
    ) -> Result<(), ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::ResetConfiguration {
                section: section.into(),
                target,
            })? {
            ExtensionClientResult::Done => Ok(()),
            _ => Err(unexpected_result()),
        }
    }
    pub fn get_configuration(
        &self,
        section: impl Into<String>,
        resource: Option<String>,
    ) -> Result<Value, ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::ReadConfiguration {
                section: section.into(),
                resource,
            })? {
            ExtensionClientResult::Configuration { value } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }
    pub fn update_source_control(
        &self,
        registration_id: impl Into<String>,
        revision: u64,
        providers: Vec<Value>,
    ) -> Result<(), ExtensionError> {
        match self
            .services
            .call_operation(ExtensionClientOperation::ScmUpdate {
                registration_id: registration_id.into(),
                revision,
                providers,
            })? {
            ExtensionClientResult::Done => Ok(()),
            _ => Err(unexpected_result()),
        }
    }
    fn value(&self, operation: ExtensionClientOperation) -> Result<Value, ExtensionError> {
        match self.services.call_operation(operation)? {
            ExtensionClientResult::Value { value } => Ok(value),
            _ => Err(unexpected_result()),
        }
    }
}
