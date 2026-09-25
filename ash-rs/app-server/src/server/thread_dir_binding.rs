use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use ash_protocol::ThreadOrigin;
use core_api::CoreError;
use core_api::ThreadWorktreeBinder;
use core_api::ThreadWorktreeBindingRequest;
use git_turn_changes::{CommitState, TurnChangeSet, TurnChangeStore};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use worktree::{
    ManagedDirBinding, ManagedDirKind, ManagedDirOwner, ManagedDirProvisionRequest,
    ManagedDirSource, ManagedDirTarget, ManagedRepositoryBinding,
};

impl GitTurnChangesRuntime {
    pub(super) fn enforce_cleanup_policy(&self) -> Result<(), String> {
        let settings = self.dirs.worktrees.settings();
        if !settings.auto_cleanup_enabled {
            return Ok(());
        }
        let bindings = self
            .dirs
            .bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(thread_id, binding)| (thread_id.clone(), binding.clone()))
            .collect::<Vec<_>>();
        let mut eligible = Vec::new();
        for (thread_id, binding) in bindings {
            let Ok(thread) = self.threads.read_thread(&thread_id) else {
                continue;
            };
            if thread.status == ash_protocol::ThreadStatus::Active {
                continue;
            }
            let settled = if binding.kind() == ManagedDirKind::Directory {
                true
            } else {
                self.store
                    .list_for_thread(&thread_id)
                    .map_err(|error| error.to_string())?
                    .iter()
                    .all(|record| {
                        record.files.is_empty()
                            || record.capture_state == git_turn_changes::CaptureState::Discarded
                            || matches!(record.commit_state, CommitState::Committed { .. })
                    })
            };
            if !settled {
                continue;
            }
            let modified = std::fs::metadata(binding.checkout_root())
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            eligible.push((modified, thread_id, binding));
        }
        eligible.sort_by(|left, right| right.0.cmp(&left.0));
        for (_, thread_id, binding) in eligible.into_iter().skip(settings.keep_count) {
            self.dirs
                .runtime
                .block_on(self.dirs.worktrees.cleanup(
                    &binding,
                    worktree::ManagedDirCleanupEligibility::AllChangeSetsSettled,
                ))
                .map_err(|error| error.to_string())?;
            self.dirs
                .bindings
                .write()
                .map_err(|_| "Thread dir binding lock poisoned".to_string())?
                .remove(&thread_id);
            self.dirs.file_access.unbind_thread_dir(&thread_id);
            self.dirs.hooks.unbind_thread_dir(&thread_id);
            self.stop_watcher(&thread_id);
        }
        Ok(())
    }

    pub(super) fn reset_thread_to_committed_changes(
        &self,
        thread_id: &ash_protocol::ThreadId,
        records: &[TurnChangeSet],
    ) -> Result<(), String> {
        let binding = self
            .binding(thread_id)
            .ok_or_else(|| format!("Thread {thread_id} has no dir binding"))?;
        self.dirs.runtime.block_on(async {
            if binding.kind() == ManagedDirKind::Directory {
                return Err("non-Git Threads do not have Git ChangeSets".into());
            }
            let git = ash_git::GitClient::system();
            for repository_binding in binding.repositories() {
                let repository = git
                    .open_repository(repository_binding.worktree_root())
                    .await
                    .map_err(|error| error.to_string())?;
                let mut desired =
                    ash_git::GitTreeId::new(repository_binding.baseline_tree().to_string())
                        .map_err(|error| error.to_string())?;
                for record in records.iter().filter(|record| {
                    record.repository_id == repository_binding.repository_id()
                        && matches!(record.commit_state, CommitState::Committed { .. })
                }) {
                    let before = ash_git::GitTreeId::new(record.before_tree.clone())
                        .map_err(|error| error.to_string())?;
                    let after =
                        ash_git::GitTreeId::new(record.after_tree.clone().ok_or_else(|| {
                            "committed ChangeSet omitted its after tree".to_string()
                        })?)
                        .map_err(|error| error.to_string())?;
                    desired = git
                        .compose_tree_delta(&repository, &before, &desired, &after)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                git.replace_managed_worktree_tree(&repository, &desired)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    pub(super) fn initial_baseline_paths(
        &self,
        binding: &ManagedDirBinding,
        repository_binding: &ManagedRepositoryBinding,
    ) -> Result<BTreeSet<PathBuf>, CoreError> {
        if binding.kind() == ManagedDirKind::Directory {
            return Ok(BTreeSet::new());
        }
        self.dirs.runtime.block_on(async {
            let git = ash_git::GitClient::system();
            let repository = git
                .open_repository(repository_binding.worktree_root())
                .await
                .map_err(|error| CoreError::Journal(error.to_string()))?;
            let target_tree = if repository_binding.target_unborn() {
                git.empty_tree(&repository)
                    .await
                    .map_err(|error| CoreError::Journal(error.to_string()))?
            } else {
                git.resolve_tree(&repository, repository_binding.target_head())
                    .await
                    .map_err(|error| CoreError::Journal(error.to_string()))?
            };
            let baseline_tree =
                ash_git::GitTreeId::new(repository_binding.baseline_tree().to_string())
                    .map_err(|error| CoreError::Journal(error.to_string()))?;
            let changes = git
                .diff_trees(&repository, &target_tree, &baseline_tree)
                .await
                .map_err(|error| CoreError::Journal(error.to_string()))?;
            Ok(changes
                .into_iter()
                .flat_map(|change| {
                    [
                        Some(change.path().to_path_buf()),
                        change.previous_path().map(PathBuf::from),
                    ]
                })
                .flatten()
                .collect())
        })
    }

    fn source_for(
        &self,
        origin: &ThreadOrigin,
    ) -> Result<(ManagedDirSource, ManagedDirTarget), CoreError> {
        if let ThreadOrigin::Message { workspace, .. } = origin {
            let ash_protocol::WorkspaceCheckpoint::Git {
                source_dir_id,
                repositories,
            } = workspace
            else {
                return Err(CoreError::Journal(
                    "message has no restorable Git file snapshot".into(),
                ));
            };
            if source_dir_id != self.dirs.id.as_str() {
                return Err(CoreError::Journal(
                    "message checkpoint belongs to a different source directory".into(),
                ));
            }
            let mut trees = BTreeMap::new();
            for repository in repositories {
                let path = PathBuf::from(&repository.relative_path);
                if path.as_os_str().is_empty()
                    || path.components().any(|part| {
                        !matches!(
                            part,
                            std::path::Component::Normal(_) | std::path::Component::CurDir
                        )
                    })
                    || trees.insert(path, repository.tree_id.clone()).is_some()
                {
                    return Err(CoreError::Journal(
                        "invalid repository paths in message checkpoint".into(),
                    ));
                }
            }
            let primary = repositories
                .iter()
                .find(|repository| repository.relative_path == ".")
                .ok_or_else(|| {
                    CoreError::Journal("message checkpoint has no primary repository".into())
                })?;
            return Ok((
                ManagedDirSource::ImmutableTree {
                    source_directory: self.dirs.root.clone(),
                    tree_id: primary_tree(&trees)?,
                    repository_trees: trees,
                },
                checkpoint_target(primary),
            ));
        }
        let parent_id = match origin {
            ThreadOrigin::Root => {
                return Ok((
                    ManagedDirSource::CurrentDirectory {
                        source_directory: self.dirs.root.clone(),
                    },
                    ManagedDirTarget::SourceHead,
                ));
            }
            ThreadOrigin::Fork {
                parent_thread_id, ..
            }
            | ThreadOrigin::Message {
                parent_thread_id, ..
            }
            | ThreadOrigin::Rewind {
                parent_thread_id, ..
            }
            | ThreadOrigin::AgentSpawn {
                parent_thread_id, ..
            } => parent_thread_id,
            ThreadOrigin::Replacement {
                source_thread_id, ..
            } => source_thread_id,
        };
        let parent = self.binding(parent_id).ok_or_else(|| {
            CoreError::Journal(format!("parent Thread {parent_id} has no dir binding"))
        })?;
        let source = match (origin, parent.kind()) {
            (ThreadOrigin::Message { .. }, _) => unreachable!("message source returned above"),
            (ThreadOrigin::Rewind { .. }, ManagedDirKind::Directory) => {
                return Err(CoreError::Journal(
                    "non-Git Threads do not have immutable Turn checkpoints".into(),
                ));
            }
            (ThreadOrigin::Fork { .. }, ManagedDirKind::Directory)
            | (ThreadOrigin::Replacement { .. }, ManagedDirKind::Directory)
            | (ThreadOrigin::AgentSpawn { .. }, ManagedDirKind::Directory) => {
                ManagedDirSource::CurrentDirectory {
                    source_directory: parent.dir().to_path_buf(),
                }
            }
            (ThreadOrigin::Rewind { before_turn_id, .. }, ManagedDirKind::Git) => {
                let records = self
                    .store
                    .list_for_thread(parent_id)
                    .map_err(|error| CoreError::Journal(error.to_string()))?
                    .into_iter()
                    .filter(|record| record.turn_id == *before_turn_id)
                    .collect::<Vec<_>>();
                if records.is_empty() {
                    return Err(CoreError::Journal(format!(
                        "rewind Turn {before_turn_id} has no immutable dir checkpoint"
                    )));
                }
                let trees = checkpoint_trees(&parent, &records, false).ok_or_else(|| {
                    CoreError::Journal(format!(
                        "rewind Turn {before_turn_id} has an incomplete repository checkpoint"
                    ))
                })?;
                ManagedDirSource::ImmutableTree {
                    source_directory: parent.dir().to_path_buf(),
                    tree_id: primary_tree(&trees)?,
                    repository_trees: trees,
                }
            }
            (
                ThreadOrigin::Fork {
                    parent_sequence, ..
                },
                ManagedDirKind::Git,
            )
            | (
                ThreadOrigin::Replacement {
                    source_sequence: parent_sequence,
                    ..
                },
                ManagedDirKind::Git,
            ) => {
                let trees = self.trees_at_sequence(parent_id, *parent_sequence)?;
                ManagedDirSource::ImmutableTree {
                    source_directory: parent.dir().to_path_buf(),
                    tree_id: primary_tree(&trees)?,
                    repository_trees: trees,
                }
            }
            (ThreadOrigin::AgentSpawn { .. }, ManagedDirKind::Git) => {
                ManagedDirSource::CurrentDirectory {
                    source_directory: parent.dir().to_path_buf(),
                }
            }
            (ThreadOrigin::Root, _) => unreachable!("root source returned above"),
        };
        let target = match (parent.target_branch(), parent.target_unborn()) {
            (Some(name), true) => ManagedDirTarget::UnbornBranch {
                name: name.to_string(),
                anchor_object_id: parent.target_head().to_string(),
            },
            (Some(name), false) => ManagedDirTarget::Branch {
                name: name.to_string(),
                object_id: parent.target_head().to_string(),
            },
            (None, _) => ManagedDirTarget::Detached {
                object_id: parent.target_head().to_string(),
            },
        };
        Ok((source, target))
    }

    fn trees_at_sequence(
        &self,
        thread_id: &ash_protocol::ThreadId,
        sequence: u64,
    ) -> Result<BTreeMap<PathBuf, String>, CoreError> {
        let updates = self
            .threads
            .thread_updates_after(thread_id, 0)
            .map_err(|error| CoreError::Journal(error.to_string()))?;
        let mut last_terminal_turn = None;
        for update in updates {
            if update.durable_sequence > sequence {
                break;
            }
            let ash_protocol::ThreadUpdate::Committed { event } = update.update else {
                continue;
            };
            match event {
                ash_protocol::ThreadEvent::TurnCompleted { turn_id, .. }
                | ash_protocol::ThreadEvent::TurnFailed { turn_id, .. }
                | ash_protocol::ThreadEvent::TurnInterrupted { turn_id, .. } => {
                    last_terminal_turn = Some(turn_id);
                }
                _ => {}
            }
        }
        let Some(turn_id) = last_terminal_turn else {
            return self
                .binding(thread_id)
                .map(|binding| {
                    binding
                        .repositories()
                        .iter()
                        .map(|repository| {
                            (
                                repository.relative_path().to_path_buf(),
                                repository.baseline_tree().to_string(),
                            )
                        })
                        .collect()
                })
                .ok_or_else(|| CoreError::Journal(format!("Thread {thread_id} has no baseline")));
        };
        let binding = self
            .binding(thread_id)
            .ok_or_else(|| CoreError::Journal(format!("Thread {thread_id} has no binding")))?;
        let records = self
            .store
            .list_for_thread(thread_id)
            .map_err(|error| CoreError::Journal(error.to_string()))?
            .into_iter()
            .filter(|record| record.turn_id == turn_id)
            .collect::<Vec<_>>();
        checkpoint_trees(&binding, &records, true).ok_or_else(|| {
            CoreError::Journal(format!(
                "Fork source Turn {turn_id} has no complete sealed dir checkpoint"
            ))
        })
    }
}

fn checkpoint_trees(
    binding: &ManagedDirBinding,
    records: &[TurnChangeSet],
    after: bool,
) -> Option<BTreeMap<PathBuf, String>> {
    binding
        .repositories()
        .iter()
        .map(|repository| {
            let record = records
                .iter()
                .find(|record| record.repository_id == repository.repository_id())?;
            let tree = if after {
                record.after_tree.clone()?
            } else {
                record.before_tree.clone()
            };
            Some((repository.relative_path().to_path_buf(), tree))
        })
        .collect()
}

fn primary_tree(trees: &BTreeMap<PathBuf, String>) -> Result<String, CoreError> {
    trees.get(Path::new(".")).cloned().ok_or_else(|| {
        CoreError::Journal("Thread checkpoint omitted its primary repository".into())
    })
}

impl ThreadWorktreeBinder for GitTurnChangesRuntime {
    fn provision(&self, request: &ThreadWorktreeBindingRequest) -> Result<(), CoreError> {
        if request.branch_name.is_some() && !matches!(&request.origin, ThreadOrigin::Root) {
            return Err(CoreError::InvalidInput(
                "only a root Thread can create a worktree branch".into(),
            ));
        }
        if let Some(binding) = self.binding(&request.thread_id) {
            if request
                .branch_name
                .as_deref()
                .is_some_and(|name| binding.target_branch() != Some(name))
            {
                return Err(CoreError::CommandConflict);
            }
            self.bind_thread_services(&request.thread_id, &binding)?;
            return Ok(());
        }
        let (source, mut target) = self.source_for(&request.origin)?;
        if let Some(name) = &request.branch_name {
            target = ManagedDirTarget::NewBranch { name: name.clone() };
        }
        self.provision_source(request, source, target)
    }
}

impl GitTurnChangesRuntime {
    pub(super) fn provision_source(
        &self,
        request: &ThreadWorktreeBindingRequest,
        source: ManagedDirSource,
        target: ManagedDirTarget,
    ) -> Result<(), CoreError> {
        if let Some(binding) = self.binding(&request.thread_id) {
            return self.bind_thread_services(&request.thread_id, &binding);
        }
        let binding = self
            .dirs
            .runtime
            .block_on(
                self.dirs.worktrees.provision(&ManagedDirProvisionRequest {
                    source,
                    target,
                    repository_targets: match &request.origin {
                        ThreadOrigin::Message {
                            workspace: ash_protocol::WorkspaceCheckpoint::Git { repositories, .. },
                            ..
                        } => repositories
                            .iter()
                            .filter(|checkpoint| checkpoint.relative_path != ".")
                            .map(|checkpoint| {
                                (
                                    PathBuf::from(&checkpoint.relative_path),
                                    checkpoint_target(checkpoint),
                                )
                            })
                            .collect(),
                        _ => BTreeMap::new(),
                    },
                    source_dir_id: self.dirs.id.to_string(),
                    owner: ManagedDirOwner::Thread {
                        thread_id: request.thread_id.to_string(),
                    },
                }),
            )
            .map_err(|error| CoreError::Journal(format!("cannot provision Thread dir: {error}")))?;
        if let ThreadOrigin::Message {
            workspace: ash_protocol::WorkspaceCheckpoint::Git { repositories, .. },
            ..
        } = &request.origin
        {
            let complete = binding.repositories().len() == repositories.len()
                && binding.repositories().iter().all(|repository| {
                    repositories.iter().any(|checkpoint| {
                        repository.relative_path() == Path::new(&checkpoint.relative_path)
                            && repository.repository_id() == checkpoint.repository_id
                            && repository.baseline_tree() == checkpoint.tree_id
                    })
                });
            if !complete {
                self.dirs
                    .runtime
                    .block_on(self.dirs.worktrees.cleanup(
                        &binding,
                        worktree::ManagedDirCleanupEligibility::AllChangeSetsSettled,
                    ))
                    .map_err(|error| {
                        CoreError::Journal(format!(
                            "cannot clean incomplete checkpoint restoration: {error}"
                        ))
                    })?;
                return Err(CoreError::Journal(
                    "message checkpoint repository coverage no longer matches the source directory"
                        .into(),
                ));
            }
        }
        self.dirs
            .bindings
            .write()
            .map_err(|_| CoreError::Journal("Thread dir binding lock poisoned".into()))?
            .insert(request.thread_id.clone(), binding);
        let binding = self.binding(&request.thread_id).ok_or_else(|| {
            CoreError::Journal("Thread dir binding disappeared after provision".into())
        })?;
        self.bind_thread_services(&request.thread_id, &binding)
    }
}

impl GitTurnChangesRuntime {
    fn bind_thread_services(
        &self,
        thread_id: &ash_protocol::ThreadId,
        binding: &ManagedDirBinding,
    ) -> Result<(), CoreError> {
        let source = self
            .weak
            .upgrade()
            .ok_or_else(|| CoreError::Journal("Thread file owner was disposed".into()))?;
        self.threads
            .install_message_checkpoint_source(thread_id.clone(), source)?;
        self.dirs
            .bind_services(thread_id, binding)
            .map_err(CoreError::Journal)?;
        if binding.kind() == ManagedDirKind::Git {
            self.start_watcher(thread_id.clone(), [binding.dir().to_path_buf()])
                .map_err(CoreError::Journal)?;
        }
        Ok(())
    }
}

fn checkpoint_target(checkpoint: &ash_protocol::RepositoryCheckpoint) -> ManagedDirTarget {
    match (&checkpoint.target_branch, checkpoint.target_unborn) {
        (Some(name), true) => ManagedDirTarget::UnbornBranch {
            name: name.clone(),
            anchor_object_id: checkpoint.target_head.clone(),
        },
        (Some(name), false) => ManagedDirTarget::Branch {
            name: name.clone(),
            object_id: checkpoint.target_head.clone(),
        },
        (None, _) => ManagedDirTarget::Detached {
            object_id: checkpoint.target_head.clone(),
        },
    }
}
