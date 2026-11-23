use crate::client_host::ClientHost;
use crate::client_host::ClientHostError;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_app_server_protocol::protocol::text_document::TextDocumentApplyParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentApplyRenameParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentApplyResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentChangeDto;
use ash_app_server_protocol::protocol::text_document::TextDocumentListParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentListResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentPrepareRenameParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentPrepareRenameResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentReadParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentReadResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentReferencesResult;
use ash_app_server_protocol::protocol::text_document::TextDocumentReleaseParams;
use ash_app_server_protocol::protocol::text_document::TextDocumentSymbolParams;
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
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub(crate) const RENAME_PREVIEW_TIMEOUT: Duration = Duration::from_secs(300);

pub(crate) struct TextDocumentHost {
    clients: Arc<ClientHost>,
    reads: Arc<Mutex<BTreeMap<String, PendingRead>>>,
    rename_commits: Arc<Mutex<BTreeMap<String, PendingRenameCommit>>>,
}

impl TextDocumentHost {
    pub(crate) fn new(clients: Arc<ClientHost>) -> Self {
        Self {
            clients,
            reads: Arc::default(),
            rename_commits: Arc::default(),
        }
    }

    /// Consumes the exact editor's single-use proof at the Bulk Edit commit boundary.
    pub(crate) fn confirm_rename(&self, owner: u64, access: &str) -> Result<(), TextDocumentError> {
        let denied =
            || TextDocumentError::Failed("Rename write authorization is no longer active".into());
        let pending = {
            let mut commits = self.rename_commits.lock().map_err(|_| denied())?;
            if !commits
                .get(access)
                .is_some_and(|pending| pending.owner == owner)
            {
                return Err(denied());
            }
            commits.remove(access).ok_or_else(denied)?
        };
        if !self.clients.is_connected(owner) || pending.cancellation.is_cancelled() {
            return Err(denied());
        }
        for target in pending.targets {
            let authorization = &target.authorization;
            authorization.ensure_active().map_err(|_| denied())?;
            let current = authorization
                .dir()
                .resolve_existing(&target.relative)
                .map_err(|_| denied())?;
            if current != target.canonical {
                return Err(TextDocumentError::Conflict);
            }
        }
        pending.cancellation.check().map_err(|_| denied())?;
        pending.confirmed.store(true, Ordering::Release);
        Ok(())
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
    pub(crate) fn connection_for_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> Result<Option<ConnectionDocuments>, TextDocumentError> {
        let binding = self.clients.binding(thread, turn).map_err(read_error)?;
        let Some(binding) = binding.filter(|binding| binding.text_documents) else {
            return Ok(None);
        };
        if !self.clients.is_connected(binding.connection_id) {
            return Err(TextDocumentError::Unavailable);
        }
        Ok(Some(ConnectionDocuments {
            clients: Arc::clone(&self.clients),
            owner: binding.connection_id,
            reads: Arc::clone(&self.reads),
            rename_commits: Arc::clone(&self.rename_commits),
            thread_id: thread.clone(),
            turn_id: turn.clone(),
        }))
    }
}

impl TextDocumentEditorProvider for TextDocumentHost {
    fn for_turn(
        &self,
        thread: &ash_protocol::ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> Result<Option<Arc<dyn TextDocumentEditor>>, TextDocumentError> {
        Ok(self
            .connection_for_turn(thread, turn)?
            .map(|documents| Arc::new(documents) as Arc<dyn TextDocumentEditor>))
    }
}

#[derive(Clone)]
struct PendingRead {
    owner: u64,
    path: PathBuf,
    authorization: Authorization,
    cancellation: CancellationToken,
}

/// One checked text-only rename target, retaining the original path used by the editor.
pub(crate) struct RenameWriteTarget {
    pub(crate) relative: PathBuf,
    pub(crate) canonical: PathBuf,
    pub(crate) authorization: Authorization,
}

struct PendingRenameCommit {
    owner: u64,
    targets: Vec<RenameWriteTarget>,
    cancellation: CancellationToken,
    confirmed: Arc<AtomicBool>,
}

fn new_access_id() -> Result<String, TextDocumentError> {
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random)
        .map_err(|error| TextDocumentError::Failed(error.to_string()))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
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

pub(crate) struct ConnectionDocuments {
    clients: Arc<ClientHost>,
    owner: u64,
    reads: Arc<Mutex<BTreeMap<String, PendingRead>>>,
    rename_commits: Arc<Mutex<BTreeMap<String, PendingRenameCommit>>>,
    thread_id: ash_protocol::ThreadId,
    turn_id: ash_protocol::TurnId,
}

impl ConnectionDocuments {
    fn lease_read(
        &self,
        path: &Path,
        authorization: &Authorization,
        cancellation: &CancellationToken,
    ) -> Result<ReadLease<'_>, TextDocumentError> {
        let id = new_access_id()?;
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
        Ok(ReadLease {
            reads: &self.reads,
            id,
        })
    }

    pub(crate) fn references(
        &self,
        path: &Path,
        position: LanguagePositionDto,
        authorization: &Authorization,
        cancellation: &CancellationToken,
    ) -> Result<TextDocumentReferencesResult, TextDocumentError> {
        let lease = self.lease_read(path, authorization, cancellation)?;
        let result = self
            .clients
            .request(
                self.owner,
                HostMethod::TextDocumentReferences,
                &TextDocumentSymbolParams {
                    path: path.to_string_lossy().into_owned(),
                    read_access: lease.id.clone(),
                    position,
                },
                cancellation,
            )
            .map_err(read_error)?;
        authorization
            .ensure_active()
            .map_err(|error| TextDocumentError::Failed(error.to_string()))?;
        Ok(result)
    }

    pub(crate) fn prepare_rename(
        &self,
        path: &Path,
        position: LanguagePositionDto,
        names: (String, String),
        authorization: &Authorization,
        cancellation: &CancellationToken,
    ) -> Result<(String, TextDocumentPrepareRenameResult), TextDocumentError> {
        let lease = self.lease_read(path, authorization, cancellation)?;
        let snapshot = new_access_id()?;
        let response = self.clients.request(
            self.owner,
            HostMethod::TextDocumentPrepareRename,
            &TextDocumentPrepareRenameParams {
                snapshot: snapshot.clone(),
                target: TextDocumentSymbolParams {
                    path: path.to_string_lossy().into_owned(),
                    read_access: lease.id.clone(),
                    position,
                },
                symbol: names.0,
                new_name: names.1,
            },
            cancellation,
        );
        match response {
            Ok(result) => Ok((snapshot, result)),
            Err(error) => {
                self.release(vec![snapshot]);
                Err(read_error(error))
            }
        }
    }

    pub(crate) fn apply_rename(
        &self,
        snapshot: String,
        targets: Vec<RenameWriteTarget>,
        cancellation: &CancellationToken,
    ) -> Result<TextDocumentApplyResult, TextDocumentError> {
        let access = new_access_id()?;
        let confirmed = Arc::new(AtomicBool::new(false));
        self.rename_commits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                access.clone(),
                PendingRenameCommit {
                    owner: self.owner,
                    targets,
                    cancellation: cancellation.clone(),
                    confirmed: Arc::clone(&confirmed),
                },
            );
        let result = self.clients.request_with_timeout(
            self.owner,
            HostMethod::TextDocumentApplyRename,
            &TextDocumentApplyRenameParams {
                snapshot: snapshot.clone(),
                access: access.clone(),
            },
            cancellation,
            RENAME_PREVIEW_TIMEOUT,
        );
        self.rename_commits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&access);
        let confirmed = confirmed.load(Ordering::Acquire);
        if result.is_err() {
            self.release(vec![snapshot]);
        }
        match result {
            Ok(TextDocumentApplyResult::Applied) if !confirmed => Err(TextDocumentError::Failed(
                "Editor did not confirm rename write authorization".into(),
            )),
            Err(error) if confirmed => Err(TextDocumentError::OutcomeUnknown(format!(
                "editor rename response was lost: {error:?}"
            ))),
            result => result.map_err(read_error),
        }
    }
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
        let lease = self.lease_read(path, authorization, cancellation)?;
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
