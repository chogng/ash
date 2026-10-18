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
use ash_file_access::Authorization;
use ash_file_system::FileContent;
use ash_file_system::FileSystemError;
use ash_file_system::FileTextDocuments;
use ash_tools::TextDocumentChange;
use ash_tools::TextDocumentContent;
use ash_tools::TextDocumentEditor;
use ash_tools::TextDocumentEditorProvider;
use ash_tools::TextDocumentError;
use ash_tools::TextDocumentSnapshot;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

pub(crate) struct TextDocumentHost {
    clients: Arc<ClientHost>,
    reads: Arc<Mutex<BTreeMap<String, PendingRead>>>,
}

impl TextDocumentHost {
    pub(crate) fn new(clients: Arc<ClientHost>) -> Self {
        Self {
            clients,
            reads: Arc::default(),
        }
    }

    pub(crate) fn read_content(
        &self,
        owner: u64,
        access: &str,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        let denied =
            || FileSystemError::PermissionDenied("invalid document read authorization".into());
        let read = self
            .reads
            .lock()
            .map_err(|_| denied())?
            .get(access)
            .filter(|read| read.owner == owner && read.path == path)
            .cloned()
            .ok_or_else(denied)?;
        if !self.clients.is_connected(owner) || read.cancellation.is_cancelled() {
            return Err(denied());
        }
        let authorization = &read.authorization;
        let content = authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                authorization.permission(),
                || {
                    FileTextDocuments::new(authorization.dir().clone()).read_content_with_policy(
                        path,
                        authorization.path_policy(),
                        maximum_bytes,
                    )
                },
            )
            .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))??;
        if !self.clients.is_connected(owner)
            || read.cancellation.is_cancelled()
            || !self
                .reads
                .lock()
                .map_err(|_| denied())?
                .contains_key(access)
        {
            return Err(denied());
        }
        authorization
            .ensure_active()
            .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))?;
        Ok(content)
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
            reads: Arc::clone(&self.reads),
            thread_id: thread.clone(),
            turn_id: turn.clone(),
        })))
    }
}

#[derive(Clone)]
struct PendingRead {
    owner: u64,
    path: PathBuf,
    authorization: Authorization,
    cancellation: CancellationToken,
}

// The callback owns the proof's lifetime, including timeout and transport failures.
struct ReadLease<'a> {
    reads: &'a Mutex<BTreeMap<String, PendingRead>>,
    id: String,
}

impl Drop for ReadLease<'_> {
    fn drop(&mut self) {
        self.reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
    }
}

struct ConnectionDocuments {
    clients: Arc<ClientHost>,
    owner: u64,
    reads: Arc<Mutex<BTreeMap<String, PendingRead>>>,
    thread_id: ash_protocol::ThreadId,
    turn_id: ash_protocol::TurnId,
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

    fn read_with_policy(
        &self,
        _path: &Path,
        _policy: &ash_file_access::PathAccessPolicy,
        _cancellation: &CancellationToken,
    ) -> Result<Option<TextDocumentSnapshot>, TextDocumentError> {
        // A relative policy alone cannot authorize deferred IO against a directory.
        Err(TextDocumentError::Unavailable)
    }

    fn read_authorized(
        &self,
        path: &Path,
        authorization: &Authorization,
        cancellation: &CancellationToken,
    ) -> Result<Option<TextDocumentSnapshot>, TextDocumentError> {
        let mut random = [0_u8; 32];
        getrandom::getrandom(&mut random)
            .map_err(|error| TextDocumentError::Failed(error.to_string()))?;
        let id = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.reads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                id.clone(),
                PendingRead {
                    owner: self.owner,
                    path: path.into(),
                    authorization: authorization.clone(),
                    cancellation: cancellation.clone(),
                },
            );
        let lease = ReadLease {
            reads: &self.reads,
            id,
        };
        let result: TextDocumentReadResult = self
            .clients
            .request(
                self.owner,
                HostMethod::TextDocumentRead,
                &TextDocumentReadParams {
                    path: path.to_string_lossy().into_owned(),
                    read_access: lease.id.clone(),
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

    fn apply_with_policy(
        &self,
        changes: Vec<TextDocumentChange>,
        _policy: &ash_file_access::PathAccessPolicy,
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
                &TextDocumentApplyParams {
                    thread_id: self.thread_id.clone(),
                    turn_id: self.turn_id.clone(),
                    changes,
                },
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
