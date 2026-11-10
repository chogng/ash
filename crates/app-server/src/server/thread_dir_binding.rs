use super::git_turn_changes_runtime::GitRuntimeHandle;
use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadOrigin;
use ash_protocol::WorkspaceCheckpoint;
use core_api::CoreError;
use core_api::ThreadWorktreeBinder;
use core_api::ThreadWorktreeBindingRequest;
use git_turn_changes::CommitState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeStore;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use worktree::ManagedDirBinding;
use worktree::ManagedDirKind;
use worktree::ManagedDirOwner;
use worktree::ManagedDirProvisionRequest;
use worktree::ManagedDirSource;
use worktree::ManagedDirTarget;

#[cfg(test)]
#[path = "thread_dir_binding_tests.rs"]
mod tests;

impl GitTurnChangesRuntime {
    pub(super) fn bind_prepared_directory(
        &self,
        thread: &ash_protocol::ThreadId,
        binding: ManagedDirBinding,
    ) -> Result<(), CoreError> {
        self.dirs
            .bindings
            .write()
            .map_err(|_| CoreError::Journal("Thread directory lock poisoned".into()))?
            .insert(thread.clone(), binding.clone());
        self.bind_thread_services(thread, &binding)
    }

    pub(super) fn cleanup_workflow_thread(
        &self,
        thread: &ash_protocol::ThreadId,
    ) -> Result<(), String> {
        let Some(binding) = self.binding(thread) else {
            return Ok(());
        };
        self.cleanup_thread_binding(
            thread,
            &binding,
            worktree::ManagedDirCleanupEligibility::WorkflowTerminal,
        )
    }

    /// Cleans a binding after its Session history has been deleted by an explicit user action.
    pub(super) fn cleanup_deleted_thread(
        &self,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<(), String> {
        let Some(binding) = self.binding(thread_id) else {
            return Ok(());
        };
        self.cleanup_thread_binding(
            thread_id,
            &binding,
            worktree::ManagedDirCleanupEligibility::SessionDeletedByUser,
        )
    }

    pub(super) fn cleanup_archived_worktree(
        &self,
        thread_id: &ThreadId,
        checkout: &Path,
    ) -> Result<(), String> {
        let Some(binding) = self.binding(thread_id) else {
            // A retried request can arrive after automatic cleanup has removed the checkout.
            return if checkout.exists() {
                Err("Thread worktree ownership changed".into())
            } else {
                Ok(())
            };
        };
        if binding.checkout_root() != checkout
            || binding.kind() != ManagedDirKind::Git
            || !self.changes_settled(thread_id)?
        {
            return Err("Thread worktree is no longer eligible for cleanup".into());
        }
        self.cleanup_thread_binding(
            thread_id,
            &binding,
            worktree::ManagedDirCleanupEligibility::ArchivedGitCheckoutSelectedByUser,
        )
    }

    fn cleanup_thread_binding(
        &self,
        thread_id: &ash_protocol::ThreadId,
        binding: &ManagedDirBinding,
        eligibility: worktree::ManagedDirCleanupEligibility,
    ) -> Result<(), String> {
        let _cleanup = self
            .dirs
            .cleanup_gate
            .lock()
            .map_err(|_| "Thread worktree cleanup lock poisoned")?;
        match self.binding(thread_id) {
            None => return Ok(()),
            Some(current) if &current != binding => {
                return Err("Thread worktree ownership changed".into());
            }
            Some(_) => {}
        }
        self.dirs.release_search(binding.checkout_root())?;
        // Windows directory capabilities pin their roots. Release the owning services
        // before deletion and restore them on failure so cleanup can be retried.
        self.stop_watcher(thread_id);
        self.dirs.file_access.unbind_thread_dir(thread_id);
        self.dirs.hooks.unbind_thread_dir(thread_id);
        if let Err(error) = self
            .dirs
            .runtime
            .block_on(self.dirs.manager_for(binding).cleanup(binding, eligibility))
        {
            self.bind_thread_services(thread_id, binding)
                .map_err(|error| error.to_string())?;
            return Err(error.to_string());
        }
        self.dirs
            .bindings
            .write()
            .map_err(|_| "Thread dir binding lock poisoned".to_string())?
            .remove(thread_id);
        Ok(())
    }

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
            // Non-Git copies have no ChangeSet or durable snapshot from which to recover edits.
            // Only explicit deletion (or the workflow owner) may remove them.
            if binding.kind() == ManagedDirKind::Directory {
                continue;
            }
            let Ok(thread) = self.threads.read_thread(&thread_id) else {
                continue;
            };
            if thread.status == ash_protocol::ThreadStatus::Active {
                continue;
            }
            if !self.changes_settled(&thread_id)? {
                continue;
            }
            let modified = std::fs::metadata(binding.checkout_root())
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            eligible.push((modified, thread_id, binding));
        }
        eligible.sort_by(|left, right| right.0.cmp(&left.0));
        for (_, thread_id, binding) in eligible.into_iter().skip(settings.keep_count) {
            self.cleanup_thread_binding(
                &thread_id,
                &binding,
                worktree::ManagedDirCleanupEligibility::AllChangeSetsSettled,
            )?;
        }
        Ok(())
    }

    fn changes_settled(&self, thread_id: &ThreadId) -> Result<bool, String> {
        Ok(self
            .store
            .list_for_thread(thread_id)
            .map_err(|error| error.to_string())?
            .iter()
            .all(|record| {
                record.files.is_empty()
                    || record.capture_state == git_turn_changes::CaptureState::Discarded
                    || matches!(record.commit_state, CommitState::Committed { .. })
            }))
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
                        && record.worktree_root == repository_binding.worktree_root()
                        && !record.committed_paths.is_empty()
                }) {
                    let before = ash_git::GitTreeId::new(record.before_tree.clone())
                        .map_err(|error| error.to_string())?;
                    let after =
                        ash_git::GitTreeId::new(record.after_tree.clone().ok_or_else(|| {
                            "committed ChangeSet omitted its after tree".to_string()
                        })?)
                        .map_err(|error| error.to_string())?;
                    let selected = git
                        .select_tree_changes(
                            &repository,
                            &before,
                            &after,
                            &record.committed_paths.iter().cloned().collect::<Vec<_>>(),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    desired = match git
                        .replay_tree_delta(&repository, &before, &desired, &selected)
                        .await
                        .map_err(|error| error.to_string())?
                    {
                        ash_git::GitTreeReplayResult::Clean(tree) => tree,
                        ash_git::GitTreeReplayResult::Conflict { paths } => {
                            return Err(format!(
                                "committed changes cannot reconstruct Thread: {paths:?}"
                            ));
                        }
                    };
                }
                git.replace_managed_worktree_tree(&repository, &desired)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    fn source_for(
        &self,
        request: &ThreadWorktreeBindingRequest,
    ) -> Result<(ManagedDirSource, ManagedDirTarget), CoreError> {
        if let ThreadOrigin::AgentSpawn {
            parent_thread_id,
            delegation_id,
            ..
        } = &request.origin
        {
            let intent = self.workflows.read_parallel_binding_intent(
                &request.session_id,
                parent_thread_id,
                delegation_id,
            )?;
            if let Some(intent) = intent {
                // Store validates the candidate against the coordinator's run; its source may be a worker.
                let source = self.binding(&intent.source_thread).ok_or_else(|| {
                    CoreError::Journal(format!(
                        "parallel source Thread {} has no managed directory",
                        intent.source_thread
                    ))
                })?;
                if source.kind() != ManagedDirKind::Git {
                    return Err(CoreError::InvalidInput(
                        "parallel development requires a Git-backed source Thread".into(),
                    ));
                }
                let source_snapshot = self.threads.read_thread(&intent.source_thread)?;
                if source_snapshot.session_id != request.session_id {
                    return Err(CoreError::Policy(
                        "parallel binding belongs to another Session".into(),
                    ));
                }
                let repository_trees = intent
                    .repository_trees
                    .into_iter()
                    .map(|(path, tree)| (PathBuf::from(path), tree))
                    .collect::<BTreeMap<_, _>>();
                return Ok((
                    ManagedDirSource::ImmutableTree {
                        source_directory: source.dir().to_path_buf(),
                        tree_id: primary_tree(&repository_trees)?,
                        repository_trees,
                    },
                    ManagedDirTarget::Detached {
                        object_id: intent.target_oid,
                    },
                ));
            }
            if delegation_id.as_str().starts_with("parallel-") {
                return Err(CoreError::Policy(
                    "parallel AgentSpawn has no durable immutable binding intent".into(),
                ));
            }
        }
        let origin = &request.origin;
        if let ThreadOrigin::Message {
            workspace:
                ash_protocol::WorkspaceCheckpoint::Directory {
                    source_dir_id,
                    digest,
                },
            ..
        } = origin
        {
            if source_dir_id != self.dirs.id.as_str() {
                return Err(CoreError::Journal(
                    "message checkpoint belongs to a different source directory".into(),
                ));
            }
            return Ok((
                ManagedDirSource::DirectoryCheckpoint {
                    source_directory: self.dirs.root.clone(),
                    digest: digest.clone(),
                },
                ManagedDirTarget::SourceHead,
            ));
        }
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
            | ThreadOrigin::Comparison {
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
            ThreadOrigin::SideChat {
                context_thread_id, ..
            } => context_thread_id,
        };
        let parent = self.binding(parent_id).ok_or_else(|| {
            CoreError::Journal(format!("parent Thread {parent_id} has no dir binding"))
        })?;
        if let ThreadOrigin::Rewind { before_turn_id, .. } = origin
            && let Some(source) =
                self.rewind_directory_source(&parent, parent_id, before_turn_id)?
        {
            return Ok((source, ManagedDirTarget::SourceHead));
        }
        let source = match (origin, parent.kind()) {
            (ThreadOrigin::Message { .. }, _) => unreachable!("message source returned above"),
            (ThreadOrigin::Rewind { before_turn_id, .. }, ManagedDirKind::Directory) => {
                return Err(CoreError::Journal(format!(
                    "rewind Turn {before_turn_id} has no usable directory checkpoint"
                )));
            }
            (ThreadOrigin::Comparison { .. }, ManagedDirKind::Directory) => {
                return Err(CoreError::InvalidInput(
                    "comparison requires an immutable Git checkpoint".into(),
                ));
            }
            (ThreadOrigin::Fork { .. }, ManagedDirKind::Directory)
            | (ThreadOrigin::SideChat { .. }, ManagedDirKind::Directory)
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
                ThreadOrigin::Comparison {
                    parent_sequence, ..
                },
                ManagedDirKind::Git,
            )
            | (
                ThreadOrigin::SideChat {
                    context_sequence: parent_sequence,
                    ..
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

    fn rewind_directory_source(
        &self,
        parent: &ManagedDirBinding,
        parent_id: &ThreadId,
        before_turn_id: &ash_protocol::TurnId,
    ) -> Result<Option<ManagedDirSource>, CoreError> {
        let snapshot = self.threads.read_thread(parent_id)?;
        let prompt = snapshot.items.iter().find_map(|item| match item {
            ThreadItem::UserMessage {
                item_id, turn_id, ..
            } if turn_id == before_turn_id => Some(item_id),
            _ => None,
        });
        let Some(prompt) = prompt else {
            return Ok(None);
        };
        let checkpoint = self
            .threads
            .message_checkpoints(parent_id)?
            .into_iter()
            .find(|point| &point.item_id == prompt);
        let location = match checkpoint {
            Some(point) => match point.workspace {
                WorkspaceCheckpoint::Directory {
                    source_dir_id,
                    digest,
                } if parent.kind() == ManagedDirKind::Directory
                    && source_dir_id == self.dirs.id.as_str() =>
                {
                    return Ok(Some(ManagedDirSource::DirectoryCheckpoint {
                        source_directory: self.dirs.root.clone(),
                        digest,
                    }));
                }
                WorkspaceCheckpoint::Git { source_dir_id, .. }
                    if source_dir_id == self.dirs.id.as_str() =>
                {
                    // Git rewinds use the existing immutable Turn change records.
                    return Ok(None);
                }
                _ => Some((point.source_thread_id, point.source_sequence)),
            },
            None if snapshot.origin.is_root() => snapshot
                .item_sequences
                .get(prompt)
                .map(|sequence| (parent_id.clone(), *sequence)),
            None => None,
        };
        if snapshot.kind == ash_protocol::SessionKind::Chat
            && let Some((thread_id, sequence)) = location
            && self
                .threads
                .read_thread_at_sequence(&thread_id, sequence)?
                .execution_target
                .is_none()
        {
            // Unbound Chat can record checkpoints in an internal scratch directory.
            // A newly attached workspace starts from its own source, never the scratch
            // snapshot or the parent Thread's later workspace edits.
            return Ok(Some(ManagedDirSource::CurrentDirectory {
                source_directory: self.dirs.root.clone(),
            }));
        }
        Ok(None)
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
                // Live summaries also retain an after tree; historical forks still require
                // the final capture after execution and its hooks have settled.
                record.terminal_state?;
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

impl ThreadWorktreeBinder for GitRuntimeHandle {
    fn provision(&self, request: &ThreadWorktreeBindingRequest) -> Result<(), CoreError> {
        self.upgrade()?.provision(request)
    }
}

impl ThreadWorktreeBinder for GitTurnChangesRuntime {
    fn provision(&self, request: &ThreadWorktreeBindingRequest) -> Result<(), CoreError> {
        if let Some(binding) = self.binding(&request.thread_id) {
            if binding.source_dir_id() != self.dirs.id.as_str()
                || request
                    .branch_name
                    .as_deref()
                    .is_some_and(|name| binding.target_branch() != Some(name))
                || request
                    .worktree_start
                    .as_ref()
                    .is_some_and(|start| binding.target_head() != start.commit)
            {
                return Err(CoreError::CommandConflict);
            }
            self.bind_thread_services(&request.thread_id, &binding)?;
            return Ok(());
        }

        if let Some(start) = &request.worktree_start {
            let name = request
                .branch_name
                .as_ref()
                .filter(|_| matches!(request.origin, ThreadOrigin::Root))
                .ok_or_else(|| {
                    CoreError::InvalidInput("a pinned worktree requires a new root branch".into())
                })?;
            let tree_id = self
                .dirs
                .runtime
                .block_on(async {
                    let git = ash_git::GitClient::system();
                    let repository = git.open_repository(&self.dirs.root).await?;
                    git.fetch_remote_tree(
                        &repository,
                        &start.remote,
                        &start.remote_identity,
                        &start.reference,
                        &start.commit,
                    )
                    .await
                })
                .map_err(|error| {
                    CoreError::InvalidInput(format!(
                        "cannot fetch the selected worktree commit: {error}"
                    ))
                })?;
            return self.provision_source(
                request,
                ManagedDirSource::ImmutableTree {
                    source_directory: self.dirs.root.clone(),
                    tree_id: tree_id.as_str().to_owned(),
                    repository_trees: BTreeMap::new(),
                },
                ManagedDirTarget::NewBranch {
                    name: name.clone(),
                    base_object_id: Some(start.commit.clone()),
                },
            );
        }
        let (source, mut target) = self.source_for(request)?;
        if let Some(name) = &request.branch_name {
            let base_object_id = match (&request.origin, &source, target) {
                (ThreadOrigin::Root, _, _) => None,
                (
                    ThreadOrigin::Comparison { .. },
                    ManagedDirSource::ImmutableTree { .. },
                    ManagedDirTarget::Branch { object_id, .. }
                    | ManagedDirTarget::Detached { object_id },
                ) => Some(object_id),
                (
                    ThreadOrigin::Comparison { .. },
                    ManagedDirSource::ImmutableTree { .. },
                    ManagedDirTarget::UnbornBranch {
                        anchor_object_id, ..
                    },
                ) => Some(anchor_object_id),
                _ => {
                    return Err(CoreError::InvalidInput(
                        "comparison requires an immutable Git checkpoint".into(),
                    ));
                }
            };
            target = ManagedDirTarget::NewBranch {
                name: name.clone(),
                base_object_id,
            };
        }
        self.provision_source(request, source, target)
    }
}

impl GitTurnChangesRuntime {
    pub(super) fn prepare_switched_directory(&self, thread: &ThreadId) -> Result<(), CoreError> {
        if self.binding(thread).is_some() || self.original_directory(thread).is_some() {
            return Ok(());
        }
        self.dirs
            .runtime
            .block_on(
                self.dirs
                    .switched_worktrees
                    .provision(&ManagedDirProvisionRequest {
                        source: ManagedDirSource::CurrentDirectory {
                            source_directory: self.dirs.root.clone(),
                        },
                        target: ManagedDirTarget::SourceHead,
                        repository_targets: BTreeMap::new(),
                        source_dir_id: self.dirs.id.to_string(),
                        owner: ManagedDirOwner::Thread {
                            thread_id: thread.to_string(),
                        },
                    }),
            )
            .map_err(|error| {
                CoreError::Journal(format!("cannot prepare destination directory: {error}"))
            })?;
        Ok(())
    }

    pub(super) fn activate_switched_directory(&self, thread: &ThreadId) -> Result<(), CoreError> {
        if let Some(binding) = self.binding(thread) {
            return self.bind_thread_services(thread, &binding);
        }
        let owner = ManagedDirOwner::Thread {
            thread_id: thread.to_string(),
        };
        let binding = match self.original_directory(thread) {
            Some(binding) => binding,
            None => self
                .dirs
                .runtime
                .block_on(self.dirs.switched_worktrees.recover_owner(&owner))
                .map_err(|error| {
                    CoreError::Journal(format!("cannot recover destination directory: {error}"))
                })?,
        };
        self.bind_prepared_directory(thread, binding)
    }

    fn original_directory(&self, thread: &ThreadId) -> Option<ManagedDirBinding> {
        let owner = ManagedDirOwner::Thread {
            thread_id: thread.to_string(),
        };
        self.dirs
            .runtime
            .block_on(self.dirs.worktrees.recover_owner(&owner))
            .ok()
            .filter(|binding| binding.source_dir_id() == self.dirs.id.as_str())
    }

    pub(super) fn release_switched_directory(&self, thread: &ThreadId) {
        self.stop_watcher(thread);
        self.dirs.file_access.unbind_thread_dir(thread);
        self.dirs.hooks.unbind_thread_dir(thread);
        self.dirs
            .bindings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(thread);
    }

    pub(super) fn provision_source(
        &self,
        request: &ThreadWorktreeBindingRequest,
        source: ManagedDirSource,
        target: ManagedDirTarget,
    ) -> Result<(), CoreError> {
        if let Some(binding) = self.binding(&request.thread_id) {
            if binding.source_dir_id() != self.dirs.id.as_str() {
                return Err(CoreError::CommandConflict);
            }
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
    pub(super) fn refresh_capture_object_locations(
        &self,
        thread_id: &ash_protocol::ThreadId,
        binding: &ManagedDirBinding,
    ) -> Result<(), String> {
        self.dirs.runtime.block_on(async {
            let git = ash_git::GitClient::system();
            for repository in binding.repositories() {
                let opened = git
                    .open_repository(repository.source_repository_root())
                    .await
                    .map_err(|error| error.to_string())?;
                git_turn_changes::relocate_capture_objects(
                    self.store.as_ref(),
                    thread_id,
                    repository.repository_id(),
                    opened.common_dir(),
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

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
        self.start_file_watcher(thread_id, binding)
            .map_err(CoreError::Journal)?;
        if binding.kind() == ManagedDirKind::Git {
            self.refresh_capture_object_locations(thread_id, binding)
                .map_err(CoreError::Journal)?;
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
