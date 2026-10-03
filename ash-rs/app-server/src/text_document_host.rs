use crate::client_host::ClientHost;
use crate::client_host::ClientHostError;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_app_server_protocol::protocol::text_document::TextDocumentApplyParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentApplyResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentChangeDto;
use ash_app_server_protocol::protocol::text_document::TextDocumentListParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentListResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentReadParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentReadResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentReleaseParams;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_tools::TextDocumentChange;
use ash_tools::TextDocumentContent;
use ash_tools::TextDocumentEditor;
use ash_tools::TextDocumentEditorProvider;
use ash_tools::TextDocumentError;
use ash_tools::TextDocumentSnapshot;
use std::path::Path;
use std::sync::Arc;

pub(crate) struct TextDocumentHost {
    clients: Arc<ClientHost>,
}

impl TextDocumentHost {
    pub(crate) fn new(clients: Arc<ClientHost>) -> Self {
        Self { clients }
    }
}

impl TextDocumentEditorProvider for TextDocumentHost {
    fn for_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> Result<Option<Arc<dyn TextDocumentEditor>>, TextDocumentError> {
        let binding = self.clients.binding(thread, turn).map_err(read_error)?;
        let Some(binding) = binding.filter(|binding| binding.text_documents) else {
            return Ok(None);
        };
        if !self.clients.is_connected(binding.connection_id) {
            return Err(TextDocumentError::Unavailable);
        }
        Ok(Some(Arc::new(ConnectionDocuments {
            clients: Arc::clone(&self.clients),
            owner: binding.connection_id,
        })))
    }
}

struct ConnectionDocuments {
    clients: Arc<ClientHost>,
    owner: u64,
}

impl TextDocumentEditor for ConnectionDocuments {
    fn open_documents(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Vec<TextDocumentContent>, TextDocumentError> {
        let result: TextDocumentListResult = self
            .clients
            .request(
                self.owner,
                HostMethod::TextDocumentList,
                &TextDocumentListParams {
                    root: root.to_string_lossy().into_owned(),
                },
                cancellation,
            )
            .map_err(read_error)?;
        match result {
            TextDocumentListResult::Documents { documents } => Ok(documents
                .into_iter()
                .map(|document| TextDocumentContent {
                    path: root.join(document.relative_path),
                    text: document.text,
                })
                .collect()),
            TextDocumentListResult::Failed { message } => Err(TextDocumentError::Failed(message)),
        }
    }

    fn read(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<TextDocumentSnapshot>, TextDocumentError> {
        let result: TextDocumentReadResult = self
            .clients
            .request(
                self.owner,
                HostMethod::TextDocumentRead,
                &TextDocumentReadParams {
                    path: path.to_string_lossy().into_owned(),
                },
                cancellation,
            )
            .map_err(read_error)?;
        match result {
            TextDocumentReadResult::Document { snapshot, text } => {
                Ok(Some(TextDocumentSnapshot { id: snapshot, text }))
            }
            TextDocumentReadResult::NotFound => Ok(None),
            TextDocumentReadResult::Failed { message } => Err(TextDocumentError::Failed(message)),
        }
    }

    fn apply(
        &self,
        changes: Vec<TextDocumentChange>,
        cancellation: &CancellationToken,
    ) -> Result<(), TextDocumentError> {
        if cancellation.is_cancelled() {
            return Err(TextDocumentError::Cancelled);
        }
        let changes = changes
            .into_iter()
            .map(|change| match change {
                TextDocumentChange::Create { path, text } => TextDocumentChangeDto::Create {
                    path: path.to_string_lossy().into_owned(),
                    text,
                },
                TextDocumentChange::Update { snapshot, text } => {
                    TextDocumentChangeDto::Update { snapshot, text }
                }
                TextDocumentChange::Delete { snapshot } => {
                    TextDocumentChangeDto::Delete { snapshot }
                }
                TextDocumentChange::Move {
                    snapshot,
                    target,
                    text,
                } => TextDocumentChangeDto::Move {
                    snapshot,
                    target: target.to_string_lossy().into_owned(),
                    text,
                },
            })
            .collect();
        let result: TextDocumentApplyResult = self
            .clients
            .request(
                self.owner,
                HostMethod::TextDocumentApply,
                &TextDocumentApplyParams { changes },
                cancellation,
            )
            .map_err(|error| {
                // Once sent, loss of the reply cannot prove that the editor rolled back the changes.
                TextDocumentError::OutcomeUnknown(format!(
                    "editor commit response was lost: {error:?}"
                ))
            })?;
        match result {
            TextDocumentApplyResult::Applied => Ok(()),
            TextDocumentApplyResult::Conflict => Err(TextDocumentError::Conflict),
            TextDocumentApplyResult::Cancelled => Err(TextDocumentError::Cancelled),
            TextDocumentApplyResult::Failed { message } => Err(TextDocumentError::Failed(message)),
            TextDocumentApplyResult::OutcomeUnknown { message } => {
                Err(TextDocumentError::OutcomeUnknown(message))
            }
        }
    }

    fn release(&self, snapshots: Vec<String>) {
        if snapshots.is_empty() {
            return;
        }
        let _ = self.clients.request::<_, ()>(
            self.owner,
            HostMethod::TextDocumentRelease,
            &TextDocumentReleaseParams { snapshots },
            &CancellationSource::new().token(),
        );
    }
}

fn read_error(error: ClientHostError) -> TextDocumentError {
    match error {
        ClientHostError::CapabilityUnavailable => TextDocumentError::Unavailable,
        ClientHostError::Cancelled(_) => TextDocumentError::Cancelled,
        ClientHostError::TimedOut => {
            TextDocumentError::Failed("editor document request timed out".into())
        }
        ClientHostError::Failed(message) => TextDocumentError::Failed(message),
    }
}

#[cfg(test)]
#[path = "text_document_host_tests.rs"]
mod tests;
