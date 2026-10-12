use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::ItemId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::WorkspaceCheckpoint;
use core_api::CheckpointCapture;
use core_api::CoreError;
use core_api::MessageCheckpointSource;
use core_api::MoveThreadHistoryRequest;
use core_api::WorkspaceRestoration;
use serde::Deserialize;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreIntent {
    version: u32,
    thread_id: ThreadId,
    command_id: CommandId,
    expected_sequence: u64,
    previous: WorkspaceCheckpoint,
    target: WorkspaceCheckpoint,
    directory_backup: Option<PathBuf>,
}

enum AppliedFiles {
    Directory(worktree::DirectoryRestoration),
    Git(Vec<(ash_git::GitRepository, ash_git::GitTreeId)>),
}

struct HistoryFileRestoration {
    runtime: Arc<GitTurnChangesRuntime>,
    intent: PathBuf,
    files: Option<AppliedFiles>,
    _capture: Box<dyn CheckpointCapture>,
    committed: bool,
}

impl WorkspaceRestoration for HistoryFileRestoration {
    fn commit(&mut self) {
        if let Some(AppliedFiles::Directory(files)) = &mut self.files {
            files.commit();
        }
        self.committed = true;
        if let Err(error) = std::fs::remove_file(&self.intent) {
            log::error!("cannot clear committed history file intent: {error}");
        }
    }
}

impl Drop for HistoryFileRestoration {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let result = match &mut self.files {
            Some(AppliedFiles::Directory(files)) => {
                files.rollback().map_err(|error| error.to_string())
            }
            Some(AppliedFiles::Git(previous)) => self.runtime.dirs.runtime.block_on(async {
                let git = ash_git::GitClient::system();
                for (repository, tree) in previous.iter().rev() {
                    git.replace_managed_worktree_tree(repository, tree)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }),
            None => Ok(()),
        };
        match result {
            Ok(()) => {
                let _ = std::fs::remove_file(&self.intent);
            }
            Err(error) => {
                log::error!("history file rollback failed; retained recovery intent: {error}")
            }
        }
    }
}

impl GitTurnChangesRuntime {
    pub(super) fn prepare_history_restore(
        &self,
        request: &MoveThreadHistoryRequest,
        expected: &WorkspaceCheckpoint,
        target: &WorkspaceCheckpoint,
    ) -> Result<Box<dyn WorkspaceRestoration>, CoreError> {
        let binding = self
            .binding(&request.thread_id)
            .ok_or_else(|| CoreError::Journal("history has no managed Thread directory".into()))?;
        if self
            .history_restoration_pending(&request.thread_id)
            .map_err(storage_error)?
        {
            return Err(CoreError::WorkspaceCheckpointConflict);
        }
        if !self
            .history_files_ready(&request.thread_id)
            .map_err(storage_error)?
        {
            return Err(CoreError::InvalidInput(
                "Thread file captures or commits are still running".into(),
            ));
        }
        let capture = self.capture(
            &request.thread_id,
            &TurnId::new("history").expect("constant ID"),
            &ItemId::new("history").expect("constant ID"),
            &format!("history-{}", request.command_id),
        )?;
        if !same_files(capture.workspace(), expected) {
            return Err(CoreError::WorkspaceCheckpointConflict);
        }
        self.validate_history_target(&binding, target)?;
        std::fs::create_dir_all(&self.history_restorations).map_err(storage_error)?;
        let intent_path = self.history_intent_path(&request.thread_id);
        let directory = match target {
            WorkspaceCheckpoint::Directory { digest, .. } => Some(
                self.dirs
                    .worktrees
                    .prepare_directory_restoration(binding.dir(), digest)
                    .map_err(storage_error)?,
            ),
            WorkspaceCheckpoint::Git { .. } => None,
            WorkspaceCheckpoint::NoFiles | WorkspaceCheckpoint::Unavailable { .. } => {
                return Err(CoreError::InvalidInput(
                    "history file checkpoint is unavailable".into(),
                ));
            }
        };
        let intent = RestoreIntent {
            version: 2,
            thread_id: request.thread_id.clone(),
            command_id: request.command_id.clone(),
            expected_sequence: request.expected_sequence,
            previous: expected.clone(),
            target: target.clone(),
            directory_backup: directory.as_ref().map(|files| files.backup().to_path_buf()),
        };
        let mut file =
            tempfile::NamedTempFile::new_in(&self.history_restorations).map_err(storage_error)?;
        file.write_all(&serde_json::to_vec(&intent).map_err(storage_error)?)
            .map_err(storage_error)?;
        file.as_file().sync_all().map_err(storage_error)?;
        file.persist_noclobber(&intent_path)
            .map_err(storage_error)?;
        #[cfg(unix)]
        std::fs::File::open(&self.history_restorations)
            .and_then(|directory| directory.sync_all())
            .map_err(storage_error)?;
        let mut restoration = HistoryFileRestoration {
            runtime: self
                .weak
                .upgrade()
                .ok_or_else(|| CoreError::Journal("history file owner was disposed".into()))?,
            intent: intent_path,
            files: directory.map(AppliedFiles::Directory),
            _capture: capture,
            committed: false,
        };
        match target {
            WorkspaceCheckpoint::Directory { .. } => {
                let Some(AppliedFiles::Directory(files)) = &mut restoration.files else {
                    unreachable!()
                };
                files.install().map_err(storage_error)?;
            }
            WorkspaceCheckpoint::Git { repositories, .. } => {
                let WorkspaceCheckpoint::Git {
                    repositories: previous,
                    ..
                } = expected
                else {
                    return Err(CoreError::WorkspaceCheckpointConflict);
                };
                let git = ash_git::GitClient::system();
                let undo = self.dirs.runtime.block_on(async {
                    let mut undo = Vec::new();
                    for repository in binding.repositories() {
                        let opened = git
                            .open_repository(repository.worktree_root())
                            .await
                            .map_err(storage_error)?;
                        let before = previous
                            .iter()
                            .find(|point| {
                                point.repository_id == repository.repository_id()
                                    && Path::new(&point.relative_path) == repository.relative_path()
                            })
                            .ok_or_else(|| {
                                CoreError::Journal(
                                    "previous history checkpoint coverage changed".into(),
                                )
                            })?;
                        undo.push((
                            opened,
                            ash_git::GitTreeId::new(before.tree_id.clone())
                                .map_err(storage_error)?,
                        ));
                    }
                    Ok::<_, CoreError>(undo)
                })?;
                restoration.files = Some(AppliedFiles::Git(undo));
                let Some(AppliedFiles::Git(undo)) = &restoration.files else {
                    unreachable!()
                };
                self.dirs.runtime.block_on(async {
                    for (opened, _) in undo {
                        let relative = opened
                            .worktree_root()
                            .strip_prefix(binding.dir())
                            .map_err(storage_error)?;
                        let relative = if relative.as_os_str().is_empty() {
                            Path::new(".")
                        } else {
                            relative
                        };
                        let point = repositories
                            .iter()
                            .find(|point| Path::new(&point.relative_path) == relative)
                            .ok_or_else(|| {
                                CoreError::Journal(
                                    "history checkpoint repository is missing".into(),
                                )
                            })?;
                        let tree = ash_git::GitTreeId::new(point.tree_id.clone())
                            .map_err(storage_error)?;
                        git.replace_managed_worktree_tree(opened, &tree)
                            .await
                            .map_err(storage_error)?;
                    }
                    Ok::<_, CoreError>(())
                })?;
            }
            WorkspaceCheckpoint::NoFiles | WorkspaceCheckpoint::Unavailable { .. } => {
                return Err(CoreError::InvalidInput(
                    "history file checkpoint is unavailable".into(),
                ));
            }
        }
        Ok(Box::new(restoration))
    }

    fn validate_history_target(
        &self,
        binding: &worktree::ManagedDirBinding,
        workspace: &WorkspaceCheckpoint,
    ) -> Result<(), CoreError> {
        match workspace {
            WorkspaceCheckpoint::Directory { source_dir_id, .. }
                if binding.kind() == worktree::ManagedDirKind::Directory
                    && source_dir_id == self.dirs.id.as_str() =>
            {
                Ok(())
            }
            WorkspaceCheckpoint::Git {
                source_dir_id,
                repositories,
            } if source_dir_id == self.dirs.id.as_str()
                && repositories.len() == binding.repositories().len() =>
            {
                self.dirs.runtime.block_on(async {
                    let git = ash_git::GitClient::system();
                    for repository in binding.repositories() {
                        let points = repositories
                            .iter()
                            .filter(|point| {
                                point.repository_id == repository.repository_id()
                                    && Path::new(&point.relative_path) == repository.relative_path()
                            })
                            .collect::<Vec<_>>();
                        if points.len() != 1 {
                            return Err(CoreError::Journal(
                                "history checkpoint coverage is invalid".into(),
                            ));
                        }
                        let opened = git
                            .open_repository(repository.worktree_root())
                            .await
                            .map_err(storage_error)?;
                        git.resolve_tree(&opened, &points[0].tree_id)
                            .await
                            .map_err(storage_error)?;
                    }
                    Ok(())
                })
            }
            WorkspaceCheckpoint::NoFiles
            | WorkspaceCheckpoint::Unavailable { .. }
            | WorkspaceCheckpoint::Directory { .. }
            | WorkspaceCheckpoint::Git { .. } => Err(CoreError::Journal(
                "history checkpoint does not belong to this Thread directory".into(),
            )),
        }
    }

    pub(super) fn recover_history_restorations(&self) -> Result<(), String> {
        let files = match std::fs::read_dir(&self.history_restorations) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for file in files {
            let path = file.map_err(|error| error.to_string())?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let intent: RestoreIntent =
                serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if intent.version != 2 || path != self.history_intent_path(&intent.thread_id) {
                return Err("invalid history restoration intent".into());
            }
            let Some(binding) = self.binding(&intent.thread_id) else {
                continue;
            };
            let backup = validate_backup_path(&binding, intent.directory_backup.as_deref())?;
            let response_sequence = intent
                .expected_sequence
                .checked_add(1)
                .ok_or("invalid history restoration sequence")?;
            let snapshot = self
                .threads
                .read_thread(&intent.thread_id)
                .map_err(|error| error.to_string())?;
            let committed = snapshot.commands.iter().any(|command| {
                command.receipt.command_id == intent.command_id
                    && command.response_sequence == response_sequence
                    && matches!(
                        command.receipt.command,
                        ash_protocol::ThreadCommand::MoveHistory { .. }
                    )
            });
            if !committed {
                self.validate_history_target(&binding, &intent.previous)
                    .map_err(|error| error.to_string())?;
                self.validate_history_target(&binding, &intent.target)
                    .map_err(|error| error.to_string())?;
                match self.validate_interrupted_files(&binding, &intent, backup.as_deref()) {
                    Ok(()) => {}
                    Err(CoreError::WorkspaceCheckpointConflict) => {
                        log::warn!(
                            "history restoration for Thread {} has later file changes; files and recovery intent retained",
                            intent.thread_id
                        );
                        continue;
                    }
                    Err(error) => return Err(error.to_string()),
                }
                match &intent.previous {
                    WorkspaceCheckpoint::Directory { digest, .. } => {
                        let mut restore = self
                            .dirs
                            .worktrees
                            .restore_directory_checkpoint(binding.dir(), digest)
                            .map_err(|error| error.to_string())?;
                        restore.commit();
                    }
                    WorkspaceCheckpoint::Git { repositories, .. } => {
                        self.dirs.runtime.block_on(async {
                            let git = ash_git::GitClient::system();
                            for repository in binding.repositories() {
                                let point = repositories
                                    .iter()
                                    .find(|point| point.repository_id == repository.repository_id())
                                    .ok_or("history rollback repository is missing")?;
                                let opened = git
                                    .open_repository(repository.worktree_root())
                                    .await
                                    .map_err(|error| error.to_string())?;
                                let tree = ash_git::GitTreeId::new(point.tree_id.clone())
                                    .map_err(|error| error.to_string())?;
                                git.replace_managed_worktree_tree(&opened, &tree)
                                    .await
                                    .map_err(|error| error.to_string())?;
                            }
                            Ok::<_, String>(())
                        })?
                    }
                    WorkspaceCheckpoint::NoFiles | WorkspaceCheckpoint::Unavailable { .. } => {
                        return Err("history rollback checkpoint is unavailable".into());
                    }
                }
            }
            if let Some(backup) = backup {
                std::fs::remove_dir_all(backup.parent().ok_or("history backup has no parent")?)
                    .map_err(|error| error.to_string())?;
            }
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn validate_interrupted_files(
        &self,
        binding: &worktree::ManagedDirBinding,
        intent: &RestoreIntent,
        backup: Option<&Path>,
    ) -> Result<(), CoreError> {
        match (&intent.previous, &intent.target) {
            (
                WorkspaceCheckpoint::Directory {
                    digest: previous, ..
                },
                WorkspaceCheckpoint::Directory { digest: target, .. },
            ) => {
                if self
                    .dirs
                    .worktrees
                    .directory_rollback_is_safe(binding.dir(), previous, target, backup)
                    .map_err(storage_error)?
                {
                    Ok(())
                } else {
                    Err(CoreError::WorkspaceCheckpointConflict)
                }
            }
            (
                WorkspaceCheckpoint::Git {
                    repositories: previous,
                    ..
                },
                WorkspaceCheckpoint::Git {
                    repositories: target,
                    ..
                },
            ) => self.dirs.runtime.block_on(async {
                let git = ash_git::GitClient::system();
                // Verify every repository before rolling any back, including partial multi-repository installs.
                for repository in binding.repositories() {
                    let opened = git
                        .open_repository(repository.worktree_root())
                        .await
                        .map_err(storage_error)?;
                    let tree = git
                        .capture_worktree_tree(&opened)
                        .await
                        .map_err(storage_error)?;
                    let expected = |points: &[ash_protocol::RepositoryCheckpoint]| {
                        points.iter().any(|point| {
                            point.repository_id == repository.repository_id()
                                && point.tree_id == tree.as_str()
                        })
                    };
                    if !expected(previous) && !expected(target) {
                        return Err(CoreError::WorkspaceCheckpointConflict);
                    }
                }
                Ok(())
            }),
            _ => Err(CoreError::Journal(
                "history restoration checkpoint kind changed".into(),
            )),
        }
    }

    pub(super) fn history_restoration_pending(&self, thread: &ThreadId) -> Result<bool, String> {
        self.history_intent_path(thread)
            .try_exists()
            .map_err(|error| error.to_string())
    }

    fn history_intent_path(&self, thread: &ThreadId) -> PathBuf {
        let digest = ContentDigest::sha256(thread.as_str().as_bytes());
        self.history_restorations
            .join(format!("{}.json", &digest.as_str()["sha256:".len()..]))
    }
}

fn same_files(left: &WorkspaceCheckpoint, right: &WorkspaceCheckpoint) -> bool {
    match (left, right) {
        (
            WorkspaceCheckpoint::Directory {
                source_dir_id: a,
                digest: b,
            },
            WorkspaceCheckpoint::Directory {
                source_dir_id: c,
                digest: d,
            },
        ) => a == c && b == d,
        (
            WorkspaceCheckpoint::Git {
                source_dir_id: a,
                repositories: b,
            },
            WorkspaceCheckpoint::Git {
                source_dir_id: c,
                repositories: d,
            },
        ) => {
            a == c
                && b.len() == d.len()
                && b.iter().all(|left| {
                    d.iter().any(|right| {
                        left.repository_id == right.repository_id
                            && left.relative_path == right.relative_path
                            && left.tree_id == right.tree_id
                    })
                })
        }
        (WorkspaceCheckpoint::NoFiles, WorkspaceCheckpoint::NoFiles) => true,
        _ => false,
    }
}

fn storage_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Journal(error.to_string())
}

#[cfg(test)]
#[path = "thread_history_files_tests.rs"]
mod tests;

// The persisted path is untrusted. Only an owned sibling staging directory may be removed.
fn validate_backup_path(
    binding: &worktree::ManagedDirBinding,
    backup: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let Some(backup) = backup else {
        return Ok(None);
    };
    let staging = backup.parent().ok_or("invalid history backup")?;
    if backup.file_name().is_none_or(|name| name != "previous")
        || staging.parent() != binding.dir().parent()
        || staging
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !name.starts_with(".history-files-"))
    {
        return Err("history backup is outside its managed directory".into());
    }
    for path in [staging, backup] {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => return Err("invalid history backup directory".into()),
        }
    }
    Ok(Some(backup.to_path_buf()))
}
