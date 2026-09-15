use crate::{
    CaptureState, ChangeFile, ChangeFileKind, ChangeSetId, CommitState, MessageState,
    TerminalTurnState, TurnChangeSet, TurnChangeSetDraft, TurnChangeStore, TurnChangeStoreError,
};
use ash_git::{GitClient, GitPrivateRef, GitTreeChange, GitTreeChangeKind, GitTreeId};
use ash_protocol::{SessionId, ThreadId, TurnId};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

/// One repository inside the managed worktree assigned to a Thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositoryCaptureTarget {
    pub repository_id: String,
    pub worktree_root: PathBuf,
    pub target_branch: Option<String>,
    pub base_object_id: Option<String>,
    pub baseline_dependency_paths: BTreeSet<PathBuf>,
}

/// File and destination versions required to restore a message after its worktree is removed.
#[derive(Clone, Debug)]
pub struct MessageCaptureTarget {
    pub repository_id: String,
    pub worktree_root: PathBuf,
    pub relative_path: PathBuf,
    pub target_branch: Option<String>,
    pub target_head: String,
    pub target_unborn: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnChangeBeginRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub repositories: Vec<RepositoryCaptureTarget>,
    pub commit_message_configured: bool,
    pub opaque_dependencies: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnChangeSealRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub terminal_state: TerminalTurnState,
}

/// Proven read/write scope of one Tool Call. Unknown shell behavior sets `opaque_dependencies`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolChangeScope {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub read_paths: BTreeSet<PathBuf>,
    pub write_paths: BTreeSet<PathBuf>,
    pub repository_paths: BTreeMap<String, PathBuf>,
    pub opaque_dependencies: bool,
}

#[derive(Clone)]
pub struct TurnChangeLedger {
    inner: Arc<LedgerInner>,
}

struct LedgerInner {
    sender: mpsc::Sender<LedgerCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for LedgerInner {
    fn drop(&mut self) {
        let _ = self.sender.send(LedgerCommand::Shutdown);
        if let Ok(worker) = self.worker.get_mut()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

impl TurnChangeLedger {
    /// Starts one in-process worker that serializes Git checkpoints and durable ledger writes.
    pub fn start(store: Arc<dyn TurnChangeStore>) -> Result<Self, TurnChangeLedgerError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| TurnChangeLedgerError::Runtime(error.to_string()))?;
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("git-turn-changes".into())
            .spawn(move || {
                let worker = LedgerWorker {
                    store,
                    git: GitClient::system(),
                };
                while let Ok(command) = receiver.recv() {
                    match command {
                        LedgerCommand::CaptureMessage {
                            event_id,
                            repositories,
                            response,
                        } => {
                            let _ = response.send(
                                runtime.block_on(worker.capture_message(&event_id, repositories)),
                            );
                        }
                        LedgerCommand::ReleaseMessage {
                            checkpoint,
                            response,
                        } => {
                            let _ = response
                                .send(runtime.block_on(worker.release_message(&checkpoint)));
                        }
                        LedgerCommand::Begin(request, response) => {
                            let _ = response.send(runtime.block_on(worker.begin(request)));
                        }
                        LedgerCommand::Seal(request, response) => {
                            let _ = response.send(runtime.block_on(worker.seal(request)));
                        }
                        LedgerCommand::Refresh {
                            session_id,
                            thread_id,
                            turn_id,
                            response,
                        } => {
                            let _ = response.send(runtime.block_on(worker.refresh(
                                &session_id,
                                &thread_id,
                                &turn_id,
                            )));
                        }
                        LedgerCommand::RecordScope(scope, response) => {
                            let _ = response.send(worker.record_scope(scope));
                        }
                        LedgerCommand::RecordAmbiguousWrite {
                            session_id,
                            thread_id,
                            turn_id,
                            warning,
                            response,
                        } => {
                            let _ = response.send(worker.record_ambiguous_write(
                                &session_id,
                                &thread_id,
                                &turn_id,
                                warning,
                            ));
                        }
                        LedgerCommand::MarkIncomplete {
                            session_id,
                            thread_id,
                            turn_id,
                            warning,
                            response,
                        } => {
                            let _ = response.send(worker.mark_incomplete(
                                &session_id,
                                &thread_id,
                                &turn_id,
                                warning,
                            ));
                        }
                        LedgerCommand::Shutdown => break,
                    }
                }
            })
            .map_err(|error| TurnChangeLedgerError::Runtime(error.to_string()))?;
        Ok(Self {
            inner: Arc::new(LedgerInner {
                sender,
                worker: Mutex::new(Some(worker)),
            }),
        })
    }

    pub fn begin_turn(
        &self,
        request: TurnChangeBeginRequest,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::Begin(request, response))
    }

    pub fn capture_message(
        &self,
        event_id: String,
        repositories: Vec<MessageCaptureTarget>,
    ) -> Result<Vec<ash_protocol::RepositoryCheckpoint>, TurnChangeLedgerError> {
        let (response, receiver) = mpsc::sync_channel(1);
        self.inner
            .sender
            .send(LedgerCommand::CaptureMessage {
                event_id,
                repositories,
                response,
            })
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?;
        receiver
            .recv()
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?
    }

    pub fn release_message(
        &self,
        checkpoint: ash_protocol::RepositoryCheckpoint,
    ) -> Result<(), TurnChangeLedgerError> {
        let (response, receiver) = mpsc::sync_channel(1);
        self.inner
            .sender
            .send(LedgerCommand::ReleaseMessage {
                checkpoint,
                response,
            })
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?;
        receiver
            .recv()
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?
    }

    pub fn seal_turn(
        &self,
        request: TurnChangeSealRequest,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::Seal(request, response))
    }

    /// Refreshes the net diff shown for an open Turn without making it committable.
    pub fn refresh_turn(
        &self,
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::Refresh {
            session_id,
            thread_id,
            turn_id,
            response,
        })
    }

    pub fn record_tool_scope(
        &self,
        scope: ToolChangeScope,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::RecordScope(scope, response))
    }

    pub fn record_ambiguous_write(
        &self,
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        warning: String,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::RecordAmbiguousWrite {
            session_id,
            thread_id,
            turn_id,
            warning,
            response,
        })
    }

    pub fn mark_turn_incomplete(
        &self,
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        warning: String,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.call(|response| LedgerCommand::MarkIncomplete {
            session_id,
            thread_id,
            turn_id,
            warning,
            response,
        })
    }

    fn call(
        &self,
        command: impl FnOnce(
            mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
        ) -> LedgerCommand,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.inner
            .sender
            .send(command(sender))
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?;
        receiver
            .recv()
            .map_err(|_| TurnChangeLedgerError::WorkerStopped)?
    }
}

enum LedgerCommand {
    CaptureMessage {
        event_id: String,
        repositories: Vec<MessageCaptureTarget>,
        response: mpsc::SyncSender<
            Result<Vec<ash_protocol::RepositoryCheckpoint>, TurnChangeLedgerError>,
        >,
    },
    ReleaseMessage {
        checkpoint: ash_protocol::RepositoryCheckpoint,
        response: mpsc::SyncSender<Result<(), TurnChangeLedgerError>>,
    },
    Begin(
        TurnChangeBeginRequest,
        mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    ),
    Seal(
        TurnChangeSealRequest,
        mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    ),
    Refresh {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        response: mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    },
    RecordScope(
        ToolChangeScope,
        mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    ),
    RecordAmbiguousWrite {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        warning: String,
        response: mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    },
    MarkIncomplete {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        warning: String,
        response: mpsc::SyncSender<Result<Vec<TurnChangeSet>, TurnChangeLedgerError>>,
    },
    Shutdown,
}

struct LedgerWorker {
    store: Arc<dyn TurnChangeStore>,
    git: GitClient,
}

impl LedgerWorker {
    async fn release_message(
        &self,
        checkpoint: &ash_protocol::RepositoryCheckpoint,
    ) -> Result<(), TurnChangeLedgerError> {
        for name in [&checkpoint.reference, &checkpoint.target_reference] {
            if !name.starts_with("refs/ash/messages/") {
                return Err(TurnChangeLedgerError::InvalidRequest(
                    "checkpoint ref is outside the message namespace".into(),
                ));
            }
            let reference = GitPrivateRef::new(name.clone())?;
            self.git
                .delete_private_ref_at_git_dir(
                    std::path::Path::new(&checkpoint.git_directory),
                    &reference,
                )
                .await?;
        }
        Ok(())
    }

    async fn capture_message(
        &self,
        event_id: &str,
        repositories: Vec<MessageCaptureTarget>,
    ) -> Result<Vec<ash_protocol::RepositoryCheckpoint>, TurnChangeLedgerError> {
        let mut captured = Vec::new();
        let result: Result<(), TurnChangeLedgerError> = async {
            for target in repositories {
                let repository = self.git.open_repository(&target.worktree_root).await?;
                let tree = self.git.capture_worktree_tree(&repository).await?;
                let digest = ash_protocol::ContentDigest::sha256(
                    format!("{event_id}:{}", target.repository_id).as_bytes(),
                );
                let reference = GitPrivateRef::new(format!(
                    "refs/ash/messages/{}",
                    digest.as_str().trim_start_matches("sha256:")
                ))?;
                let target_reference =
                    GitPrivateRef::new(format!("{}-target", reference.as_str()))?;
                captured.push(ash_protocol::RepositoryCheckpoint {
                    repository_id: target.repository_id,
                    relative_path: target.relative_path.to_string_lossy().into_owned(),
                    tree_id: tree.as_str().to_string(),
                    reference: reference.as_str().to_string(),
                    git_directory: repository.common_dir().to_string_lossy().into_owned(),
                    target_branch: target.target_branch,
                    target_head: target.target_head.clone(),
                    target_unborn: target.target_unborn,
                    target_reference: target_reference.as_str().to_string(),
                });
                self.git
                    .pin_private_ref(&repository, &reference, &tree)
                    .await?;
                self.git
                    .pin_private_commit(&repository, &target_reference, &target.target_head)
                    .await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            for checkpoint in &captured {
                self.release_message(checkpoint).await?;
            }
            return Err(error);
        }
        Ok(captured)
    }

    async fn begin(
        &self,
        request: TurnChangeBeginRequest,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        if request.repositories.is_empty() {
            return Err(TurnChangeLedgerError::InvalidRequest(
                "Turn worktree has no repository capture targets".into(),
            ));
        }
        let mut records = Vec::new();
        for target in request.repositories {
            if target.repository_id.trim().is_empty() {
                return Err(TurnChangeLedgerError::InvalidRequest(
                    "repository identity cannot be empty".into(),
                ));
            }
            let change_set_id = change_set_id(
                &request.session_id,
                &request.thread_id,
                &request.turn_id,
                &target.repository_id,
            )?;
            match self.store.load(&change_set_id) {
                Ok(existing) => {
                    validate_owner(
                        &existing,
                        &request.session_id,
                        &request.thread_id,
                        &request.turn_id,
                    )?;
                    records.push(existing);
                    continue;
                }
                Err(TurnChangeStoreError::NotFound(_)) => {}
                Err(error) => return Err(error.into()),
            }
            let before_tree = self.capture_snapshot(&target.worktree_root).await?;
            let repository = self.git.open_repository(&target.worktree_root).await?;
            let reference = before_reference(&change_set_id)?;
            self.git
                .pin_private_ref(
                    &repository,
                    &reference,
                    &GitTreeId::new(before_tree.clone())?,
                )
                .await?;
            let mut change_set = TurnChangeSet::open(TurnChangeSetDraft {
                change_set_id,
                session_id: request.session_id.clone(),
                thread_id: request.thread_id.clone(),
                turn_id: request.turn_id.clone(),
                repository_id: target.repository_id,
                worktree_root: target.worktree_root,
                target_branch: target.target_branch,
                base_object_id: target.base_object_id,
                before_tree,
                baseline_dependency_paths: target.baseline_dependency_paths,
                message_state: if request.commit_message_configured {
                    MessageState::Queued
                } else {
                    MessageState::Unconfigured
                },
            })?;
            if request.opaque_dependencies {
                change_set.record_tool_scope([], [], true)?;
            }
            self.store.insert(&change_set)?;
            records.push(change_set);
        }
        Ok(records)
    }

    async fn seal(
        &self,
        request: TurnChangeSealRequest,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        let all_records = self.store.list_for_thread(&request.thread_id)?;
        let mut sealed = Vec::new();
        for mut change_set in all_records
            .iter()
            .filter(|change_set| change_set.turn_id == request.turn_id)
            .cloned()
        {
            validate_owner(
                &change_set,
                &request.session_id,
                &request.thread_id,
                &request.turn_id,
            )?;
            if change_set.capture_state != CaptureState::Open {
                sealed.push(change_set);
                continue;
            }
            let after_tree = self.capture_snapshot(&change_set.worktree_root).await?;
            let repository = self.git.open_repository(&change_set.worktree_root).await?;
            let after_tree_id = GitTreeId::new(after_tree.clone())?;
            self.git
                .pin_private_ref(
                    &repository,
                    &after_reference(&change_set.change_set_id)?,
                    &after_tree_id,
                )
                .await?;
            let before_tree = GitTreeId::new(change_set.before_tree.clone())?;
            let changes = self
                .git
                .diff_trees(&repository, &before_tree, &after_tree_id)
                .await?
                .into_iter()
                .map(change_file)
                .collect::<Vec<_>>();
            let dependencies = dependencies_for(&change_set, &changes, &all_records);
            let expected_revision = change_set.revision;
            let unexplained_paths = changes
                .iter()
                .flat_map(|file| [Some(&file.path), file.previous_path.as_ref()])
                .flatten()
                .filter(|path| !change_set.write_paths.contains(*path))
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if change_set.attribution_incomplete || !unexplained_paths.is_empty() {
                let warning = if unexplained_paths.is_empty() {
                    "a Tool ended with an unknown write outcome".into()
                } else {
                    format!(
                        "writes outside a known Tool lifecycle: {}",
                        unexplained_paths
                            .iter()
                            .map(|path| path.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                change_set.seal_incomplete(
                    after_tree.clone(),
                    request.terminal_state,
                    changes,
                    dependencies,
                    warning,
                )?;
            } else {
                change_set.seal(after_tree, request.terminal_state, changes, dependencies)?;
            }
            self.store
                .compare_and_swap(expected_revision, &change_set)?;
            sealed.push(change_set);
        }
        if sealed.is_empty() {
            return Err(TurnChangeLedgerError::InvalidRequest(
                "Turn has no open ChangeSet".into(),
            ));
        }
        Ok(sealed)
    }

    async fn refresh(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        let mut refreshed = Vec::new();
        for mut record in self.store.list_for_thread(thread_id)? {
            if &record.turn_id != turn_id || record.capture_state != CaptureState::Open {
                continue;
            }
            validate_owner(&record, session_id, thread_id, turn_id)?;
            let after_tree = self.capture_snapshot(&record.worktree_root).await?;
            let files = self.changes_between(&record, &after_tree).await?;
            let expected_revision = record.revision;
            record.refresh_open_files(files)?;
            if record.revision != expected_revision {
                self.store.compare_and_swap(expected_revision, &record)?;
            }
            refreshed.push(record);
        }
        if refreshed.is_empty() {
            return Err(TurnChangeLedgerError::InvalidRequest(
                "Turn has no open ChangeSet".into(),
            ));
        }
        Ok(refreshed)
    }

    async fn changes_between(
        &self,
        change_set: &TurnChangeSet,
        after_tree: &str,
    ) -> Result<Vec<ChangeFile>, TurnChangeLedgerError> {
        let repository = self.git.open_repository(&change_set.worktree_root).await?;
        let before_tree = GitTreeId::new(change_set.before_tree.clone())?;
        let after_tree = GitTreeId::new(after_tree.to_string())?;
        Ok(self
            .git
            .diff_trees(&repository, &before_tree, &after_tree)
            .await?
            .into_iter()
            .map(change_file)
            .collect())
    }

    async fn capture_snapshot(
        &self,
        worktree_root: &std::path::Path,
    ) -> Result<String, TurnChangeLedgerError> {
        let repository = self.git.open_repository(worktree_root).await?;
        Ok(self
            .git
            .capture_worktree_tree(&repository)
            .await?
            .as_str()
            .to_string())
    }

    fn record_scope(
        &self,
        scope: ToolChangeScope,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.update_open(
            &scope.session_id,
            &scope.thread_id,
            &scope.turn_id,
            |record| {
                let prefix = scope
                    .repository_paths
                    .get(&record.repository_id)
                    .map(PathBuf::as_path)
                    .unwrap_or_else(|| std::path::Path::new("."));
                record.record_tool_scope(
                    repository_relative_paths(&scope.read_paths, prefix),
                    repository_relative_paths(&scope.write_paths, prefix),
                    scope.opaque_dependencies,
                )
            },
        )
    }

    fn record_ambiguous_write(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        warning: String,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.update_open(session_id, thread_id, turn_id, |record| {
            record.record_ambiguous_write(warning.clone())
        })
    }

    fn mark_incomplete(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        warning: String,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        self.update_open(session_id, thread_id, turn_id, |record| {
            record.mark_incomplete(warning.clone())
        })
    }

    fn update_open(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        update: impl Fn(&mut TurnChangeSet) -> Result<(), crate::TurnChangeError>,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeLedgerError> {
        let mut updated = Vec::new();
        for mut record in self.store.list_for_thread(thread_id)? {
            if &record.turn_id != turn_id || record.capture_state != CaptureState::Open {
                continue;
            }
            validate_owner(&record, session_id, thread_id, turn_id)?;
            let expected_revision = record.revision;
            update(&mut record)?;
            self.store.compare_and_swap(expected_revision, &record)?;
            updated.push(record);
        }
        if updated.is_empty() {
            return Err(TurnChangeLedgerError::InvalidRequest(
                "Turn has no open ChangeSet".into(),
            ));
        }
        Ok(updated)
    }
}

fn repository_relative_paths(
    paths: &BTreeSet<PathBuf>,
    prefix: &std::path::Path,
) -> BTreeSet<PathBuf> {
    if prefix == std::path::Path::new(".") {
        return paths.clone();
    }
    paths
        .iter()
        .filter_map(|path| path.strip_prefix(prefix).ok())
        .map(|path| {
            if path.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                path.to_path_buf()
            }
        })
        .collect()
}

fn dependencies_for(
    current: &TurnChangeSet,
    changes: &[ChangeFile],
    records: &[TurnChangeSet],
) -> BTreeSet<ChangeSetId> {
    let touched = changes
        .iter()
        .flat_map(|file| [Some(&file.path), file.previous_path.as_ref()])
        .flatten()
        .chain(current.read_paths.iter())
        .chain(current.write_paths.iter())
        .collect::<BTreeSet<_>>();
    records
        .iter()
        .filter(|candidate| candidate.change_set_id != current.change_set_id)
        .filter(|candidate| candidate.turn_id != current.turn_id)
        .filter(|candidate| {
            !matches!(candidate.capture_state, CaptureState::Discarded)
                && !matches!(candidate.commit_state, CommitState::Committed { .. })
        })
        .filter(|candidate| {
            if current.opaque_dependencies {
                return true;
            }
            let repository_touched = if candidate.repository_id == current.repository_id {
                touched.clone()
            } else {
                records
                    .iter()
                    .filter(|scope| {
                        scope.turn_id == current.turn_id
                            && scope.repository_id == candidate.repository_id
                    })
                    .flat_map(|scope| scope.read_paths.iter().chain(scope.write_paths.iter()))
                    .collect()
            };
            candidate.files.iter().any(|file| {
                repository_touched
                    .iter()
                    .any(|path| paths_overlap(path, &file.path))
                    || file.previous_path.as_ref().is_some_and(|previous| {
                        repository_touched
                            .iter()
                            .any(|path| paths_overlap(path, previous))
                    })
            })
        })
        .map(|candidate| candidate.change_set_id.clone())
        .collect()
}

fn paths_overlap(left: &std::path::Path, right: &std::path::Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn change_file(change: GitTreeChange) -> ChangeFile {
    ChangeFile {
        path: change.path().to_path_buf(),
        previous_path: change.previous_path().map(PathBuf::from),
        kind: match change.kind() {
            GitTreeChangeKind::Added => ChangeFileKind::Added,
            GitTreeChangeKind::Modified => ChangeFileKind::Modified,
            GitTreeChangeKind::Deleted => ChangeFileKind::Deleted,
            GitTreeChangeKind::Renamed => ChangeFileKind::Renamed,
            GitTreeChangeKind::TypeChanged => ChangeFileKind::TypeChanged,
        },
        before_object_id: change.before_object_id().map(str::to_string),
        after_object_id: change.after_object_id().map(str::to_string),
        before_mode: change.before_mode().map(str::to_string),
        after_mode: change.after_mode().map(str::to_string),
        binary: change.binary(),
        additions: change.additions(),
        deletions: change.deletions(),
    }
}

fn validate_owner(
    change_set: &TurnChangeSet,
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
) -> Result<(), TurnChangeLedgerError> {
    if &change_set.session_id != session_id
        || &change_set.thread_id != thread_id
        || &change_set.turn_id != turn_id
    {
        return Err(TurnChangeLedgerError::InvalidRequest(
            "ChangeSet identity does not match its Turn".into(),
        ));
    }
    Ok(())
}

fn change_set_id(
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    repository_id: &str,
) -> Result<ChangeSetId, TurnChangeLedgerError> {
    let mut hasher = Sha256::new();
    for value in [
        session_id.as_str(),
        thread_id.as_str(),
        turn_id.as_str(),
        repository_id,
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    Ok(ChangeSetId::new(format!("sha256:{:x}", hasher.finalize()))?)
}

fn before_reference(change_set_id: &ChangeSetId) -> Result<GitPrivateRef, TurnChangeLedgerError> {
    private_reference(change_set_id, "before")
}

fn after_reference(change_set_id: &ChangeSetId) -> Result<GitPrivateRef, TurnChangeLedgerError> {
    private_reference(change_set_id, "after")
}

fn private_reference(
    change_set_id: &ChangeSetId,
    side: &str,
) -> Result<GitPrivateRef, TurnChangeLedgerError> {
    let digest = change_set_id
        .as_str()
        .strip_prefix("sha256:")
        .ok_or_else(|| TurnChangeLedgerError::InvalidRequest("invalid ChangeSet digest".into()))?;
    Ok(GitPrivateRef::new(format!(
        "refs/ash/changes/{digest}/{side}"
    ))?)
}

#[derive(Debug, thiserror::Error)]
pub enum TurnChangeLedgerError {
    #[error("invalid Turn change request: {0}")]
    InvalidRequest(String),
    #[error("Turn change worker stopped")]
    WorkerStopped,
    #[error("Turn change runtime failed: {0}")]
    Runtime(String),
    #[error(transparent)]
    Domain(#[from] crate::TurnChangeError),
    #[error(transparent)]
    Store(#[from] TurnChangeStoreError),
    #[error(transparent)]
    Git(#[from] ash_git::GitError),
}
