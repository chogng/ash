use super::git_turn_changes_commit::spawn_commit_job;
use super::git_turn_changes_message::spawn_message_job;
use super::thread_dirs::ThreadDirs;
use super::update_broker::UpdateBroker;
use ash_app_server_protocol::protocol::turn_changes::ChangeSetId as ChangeSetIdDto;
use ash_app_server_protocol::protocol::turn_changes::ThreadDirBinding;
use ash_app_server_protocol::protocol::turn_changes::ThreadWorktreeRepositoryBindingDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeCaptureStateDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeCommitStateDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeFileStatisticsDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeMessageStateDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeSetSummary;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeTerminalStateDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesChanged;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationResult;
use ash_config::ConfigStore;
use ash_core::ThreadController;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use ash_state::SqliteTurnChangeStore;
use ash_state::TurnChangeCommandOutcome;
use core_api::ModelService;
use git_turn_changes::CaptureState;
use git_turn_changes::CommitState;
use git_turn_changes::GitTurnChangeWatcher;
use git_turn_changes::MessageState;
use git_turn_changes::TerminalTurnState;
use git_turn_changes::TurnChangeLedger;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeStore;
use git_turn_changes::WriteLifecycleTracker;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::RwLock;
use worktree::ManagedDirBinding;
use worktree::ManagedDirKind;

/// App Server adapter from Turn execution events to the Git ChangeSet domain.
pub(super) struct GitTurnChangesRuntime {
    pub(super) weak: std::sync::Weak<Self>,
    pub(super) dirs: Arc<ThreadDirs>,
    pub(super) store: Arc<SqliteTurnChangeStore>,
    pub(super) ledger: TurnChangeLedger,
    pub(super) config: Arc<ConfigStore>,
    pub(super) threads: Arc<ThreadController>,
    pub(super) model: Arc<dyn ModelService>,
    pub(super) updates: Arc<UpdateBroker>,
    pub(super) workflows: Arc<workflows::Store>,
    pub(super) capture_failures: RwLock<BTreeMap<TurnId, String>>,
    pub(super) tool_write_capabilities: RwLock<BTreeMap<(TurnId, ToolCallId), bool>>,
    pub(super) write_lifecycles: WriteLifecycleTracker,
    pub(super) watchers: RwLock<BTreeMap<ThreadId, GitTurnChangeWatcher>>,
}

impl GitTurnChangesRuntime {
    pub(super) fn open(
        database_path: &Path,
        config: Arc<ConfigStore>,
        threads: Arc<ThreadController>,
        model: Arc<dyn ModelService>,
        dirs: Arc<ThreadDirs>,
        updates: Arc<UpdateBroker>,
        workflows: Arc<workflows::Store>,
    ) -> Result<Arc<Self>, String> {
        let store = Arc::new(
            SqliteTurnChangeStore::open(database_path)
                .map_err(|error| format!("cannot open Turn change ledger: {error}"))?,
        );
        let ledger_store: Arc<dyn TurnChangeStore> = store.clone();
        let ledger = TurnChangeLedger::start(ledger_store).map_err(|error| error.to_string())?;
        let runtime = Arc::new_cyclic(|weak| Self {
            weak: weak.clone(),
            dirs: Arc::clone(&dirs),
            store,
            ledger,
            config,
            threads,
            model,
            updates,
            workflows,
            capture_failures: RwLock::new(BTreeMap::new()),
            tool_write_capabilities: RwLock::new(BTreeMap::new()),
            write_lifecycles: WriteLifecycleTracker::default(),
            watchers: RwLock::new(BTreeMap::new()),
        });
        let hook_observer: Arc<dyn core_api::HookExecutionObserver> = runtime.clone();
        dirs.hooks.set_execution_observer(hook_observer);
        for (thread_id, binding) in runtime
            .dirs
            .bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            runtime
                .threads
                .install_message_checkpoint_source(thread_id.clone(), runtime.clone())
                .map_err(|error| error.to_string())?;
            if binding.kind() == worktree::ManagedDirKind::Git {
                runtime.refresh_capture_object_locations(thread_id, binding)?;
                runtime.start_watcher(thread_id.clone(), [binding.dir().to_path_buf()])?;
            }
        }
        runtime.resume_pending_jobs()?;
        Ok(runtime)
    }

    pub(super) fn store(&self) -> &Arc<SqliteTurnChangeStore> {
        &self.store
    }

    pub(super) fn binding(&self, thread_id: &ThreadId) -> Option<ManagedDirBinding> {
        self.dirs.binding(thread_id)
    }

    pub(super) fn start_watcher(
        &self,
        thread_id: ThreadId,
        roots: impl IntoIterator<Item = std::path::PathBuf>,
    ) -> Result<(), String> {
        let mut watchers = self
            .watchers
            .write()
            .map_err(|_| "Git Turn change watcher lock poisoned".to_string())?;
        if watchers.contains_key(&thread_id) {
            return Ok(());
        }
        let store: Arc<dyn TurnChangeStore> = self.store.clone();
        let updates = Arc::clone(&self.updates);
        let publish = Arc::new(move |records: &[TurnChangeSet]| {
            publish_records(updates.as_ref(), records);
        });
        let watcher = GitTurnChangeWatcher::start(
            thread_id.clone(),
            roots.into_iter().collect(),
            self.ledger.clone(),
            store,
            self.write_lifecycles.clone(),
            publish,
        )?;
        watchers.insert(thread_id, watcher);
        Ok(())
    }

    pub(super) fn stop_watcher(&self, thread_id: &ThreadId) {
        self.watchers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(thread_id);
    }

    fn resume_pending_jobs(self: &Arc<Self>) -> Result<(), String> {
        let thread_ids = self
            .dirs
            .bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for thread_id in thread_ids {
            if self
                .binding(&thread_id)
                .is_some_and(|binding| binding.kind() == worktree::ManagedDirKind::Directory)
            {
                continue;
            }
            let records = self
                .store
                .list_for_thread(&thread_id)
                .map_err(|error| error.to_string())?;
            for record in records {
                if matches!(
                    record.message_state,
                    MessageState::Queued | MessageState::Generating
                ) && !record.files.is_empty()
                {
                    spawn_message_job(
                        Arc::clone(&self.store),
                        Arc::clone(&self.threads),
                        Arc::clone(&self.model),
                        Arc::clone(&self.config),
                        self.dirs.id.clone(),
                        Arc::clone(&self.updates),
                        record.change_set_id.clone(),
                    );
                }
            }
            for commit in
                git_turn_changes::TurnCommitStore::list_commits(self.store.as_ref(), &thread_id)
                    .map_err(|error| error.to_string())?
            {
                if matches!(
                    commit.state,
                    git_turn_changes::TurnCommitState::Queued
                        | git_turn_changes::TurnCommitState::Publishing
                        | git_turn_changes::TurnCommitState::Committed { .. }
                ) {
                    let binding = self
                        .binding(&thread_id)
                        .ok_or("Thread has no directory binding")?;
                    spawn_commit_job(
                        Arc::clone(&self.store),
                        Arc::clone(&self.updates),
                        binding,
                        commit.commit_id,
                    );
                }
            }
        }
        Ok(())
    }

    pub(super) fn public_binding(&self, thread_id: &ThreadId) -> Option<ThreadDirBinding> {
        self.binding(thread_id).map(|binding| ThreadDirBinding {
            managed_worktree_id: binding.managed_worktree_id().to_string(),
            source_dir_id: binding.source_dir_id().to_string(),
            repositories: binding
                .repositories()
                .iter()
                .map(|repository| ThreadWorktreeRepositoryBindingDto {
                    repository_id: repository.repository_id().to_string(),
                    target_branch: repository.target_branch().map(ToOwned::to_owned),
                    baseline_object_id: (!repository.target_unborn())
                        .then(|| repository.baseline_tree().to_string()),
                })
                .collect(),
            baseline_summary: match binding.kind() {
                ManagedDirKind::Git => format!(
                    "{} immutable Git repository checkpoint(s)",
                    binding.repositories().len()
                ),
                ManagedDirKind::Directory => "isolated non-Git directory copy".into(),
            },
        })
    }

    pub(super) fn list(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnChangeSet>, String> {
        if self
            .binding(thread_id)
            .is_some_and(|binding| binding.kind() == worktree::ManagedDirKind::Directory)
        {
            return Ok(Vec::new());
        }
        let records = self
            .store
            .list_for_thread(thread_id)
            .map_err(|error| error.to_string())?;
        if records
            .iter()
            .any(|record| &record.session_id != session_id)
        {
            return Err("Thread change ledger ownership does not match Session".into());
        }
        let mut open_turns = Vec::new();
        for record in &records {
            if record.capture_state == CaptureState::Open && !open_turns.contains(&record.turn_id) {
                open_turns.push(record.turn_id.clone());
            }
        }
        for turn_id in open_turns {
            let refreshed = self
                .ledger
                .refresh_turn(session_id.clone(), thread_id.clone(), turn_id)
                .map_err(|error| error.to_string())?;
            self.publish(&refreshed);
        }
        self.store
            .list_for_thread(thread_id)
            .map_err(|error| error.to_string())
    }

    pub(super) fn retry_message(
        self: &Arc<Self>,
        mut record: TurnChangeSet,
        expected_revision: u64,
        command_id: &CommandId,
        fingerprint: &str,
    ) -> Result<TurnChangesMutationResult, String> {
        require_revision(&record, expected_revision)?;
        record.queue_message().map_err(|error| error.to_string())?;
        let response = mutation_result(&[record.clone()]);
        if let Some(replayed) = self.apply_command(command_id, fingerprint, &record, &response)? {
            return Ok(replayed);
        }
        self.publish(&[record.clone()]);
        spawn_message_job(
            Arc::clone(&self.store),
            Arc::clone(&self.threads),
            Arc::clone(&self.model),
            Arc::clone(&self.config),
            self.dirs.id.clone(),
            Arc::clone(&self.updates),
            record.change_set_id.clone(),
        );
        Ok(response)
    }

    pub(super) fn update_draft(
        &self,
        mut record: TurnChangeSet,
        expected_revision: u64,
        message: String,
        command_id: &CommandId,
        fingerprint: &str,
    ) -> Result<TurnChangesMutationResult, String> {
        require_revision(&record, expected_revision)?;
        record
            .update_draft(message)
            .map_err(|error| error.to_string())?;
        let response = mutation_result(&[record.clone()]);
        if let Some(replayed) = self.apply_command(command_id, fingerprint, &record, &response)? {
            return Ok(replayed);
        }
        self.publish(&[record]);
        Ok(response)
    }

    fn apply_command(
        &self,
        command_id: &CommandId,
        fingerprint: &str,
        record: &TurnChangeSet,
        response: &TurnChangesMutationResult,
    ) -> Result<Option<TurnChangesMutationResult>, String> {
        let response_json = serde_json::to_string(response).map_err(|error| error.to_string())?;
        match self
            .store
            .apply_command(
                command_id.as_str(),
                fingerprint,
                None,
                &[record.clone()],
                &response_json,
            )
            .map_err(|error| error.to_string())?
        {
            TurnChangeCommandOutcome::Applied => Ok(None),
            TurnChangeCommandOutcome::Replayed(response) => serde_json::from_str(&response)
                .map(Some)
                .map_err(|error| error.to_string()),
        }
    }

    pub(super) fn publish(&self, records: &[TurnChangeSet]) {
        publish_records(&self.updates, records);
    }

    pub(super) fn commit_message_configured(&self) -> bool {
        self.config.read_snapshot().is_ok_and(|snapshot| {
            snapshot
                .values
                .commit_messages
                .authorized_model(
                    &self.dirs.id,
                    snapshot.values.commit_message_model.as_ref(),
                    &snapshot.values.providers,
                )
                .is_some()
        })
    }
}

fn require_revision(record: &TurnChangeSet, expected_revision: u64) -> Result<(), String> {
    if record.revision == expected_revision {
        Ok(())
    } else {
        Err(format!(
            "change-set revision conflict: expected {expected_revision}, actual {}",
            record.revision
        ))
    }
}

fn mutation_result(records: &[TurnChangeSet]) -> TurnChangesMutationResult {
    TurnChangesMutationResult {
        change_sets: records.iter().map(summary).collect(),
    }
}

pub(super) fn publish_records(updates: &UpdateBroker, records: &[TurnChangeSet]) {
    let Some(first) = records.first() else {
        return;
    };
    updates.publish_turn_changes_changed(TurnChangesChanged {
        session_id: first.session_id.clone(),
        thread_id: first.thread_id.clone(),
        change_sets: records.iter().map(summary).collect(),
    });
}

pub(super) fn summary(record: &TurnChangeSet) -> TurnChangeSetSummary {
    let (commit_state, conflict_paths, failure_message, commit_id) = match &record.commit_state {
        CommitState::PartiallyCommitted { .. } => (
            TurnChangeCommitStateDto::PartiallyCommitted,
            Vec::new(),
            None,
            None,
        ),
        CommitState::Idle => (TurnChangeCommitStateDto::Idle, Vec::new(), None, None),
        CommitState::Queued => (TurnChangeCommitStateDto::Queued, Vec::new(), None, None),
        CommitState::Committing => (TurnChangeCommitStateDto::Committing, Vec::new(), None, None),
        CommitState::Committed { object_id } => (
            TurnChangeCommitStateDto::Committed,
            Vec::new(),
            None,
            Some(object_id.clone()),
        ),
        CommitState::Conflict { paths, message } => (
            TurnChangeCommitStateDto::Conflict,
            paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            Some(message.clone()),
            None,
        ),
        CommitState::Failed { message } => (
            TurnChangeCommitStateDto::Failed,
            Vec::new(),
            Some(message.clone()),
            None,
        ),
    };
    TurnChangeSetSummary {
        change_set_id: ChangeSetIdDto(record.change_set_id.to_string()),
        session_id: record.session_id.clone(),
        thread_id: record.thread_id.clone(),
        turn_id: record.turn_id.clone(),
        repository_id: record.repository_id.clone(),
        target_branch: record.target_branch.clone(),
        statistics: TurnChangeFileStatisticsDto {
            files: record.files.len() as u64,
            additions: record.files.iter().map(|file| file.additions).sum(),
            deletions: record.files.iter().map(|file| file.deletions).sum(),
        },
        capture_state: match record.capture_state {
            CaptureState::Open => TurnChangeCaptureStateDto::Open,
            CaptureState::Sealed => TurnChangeCaptureStateDto::Sealed,
            CaptureState::Incomplete => TurnChangeCaptureStateDto::Incomplete,
            CaptureState::Discarded => TurnChangeCaptureStateDto::Discarded,
        },
        message_state: match record.message_state {
            MessageState::Unconfigured => TurnChangeMessageStateDto::Unconfigured,
            MessageState::Queued => TurnChangeMessageStateDto::Queued,
            MessageState::Generating => TurnChangeMessageStateDto::Generating,
            MessageState::Ready => TurnChangeMessageStateDto::Ready,
            MessageState::Failed => TurnChangeMessageStateDto::Failed,
        },
        commit_state,
        committed_paths: record
            .committed_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        terminal_state: record.terminal_state.map(|state| match state {
            TerminalTurnState::Completed => TurnChangeTerminalStateDto::Completed,
            TerminalTurnState::Failed => TurnChangeTerminalStateDto::Failed,
            TerminalTurnState::Interrupted => TurnChangeTerminalStateDto::Interrupted,
        }),
        dependencies: record
            .dependencies
            .iter()
            .map(|id| ChangeSetIdDto(id.to_string()))
            .collect(),
        external_dependency_paths: record
            .external_dependency_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        warnings: record.warnings.clone(),
        conflict_paths,
        failure_message,
        commit_id,
        revision: record.revision,
    }
}

impl GitTurnChangesRuntime {
    pub(super) fn require_session_publications_settled(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), String> {
        use git_turn_changes::TurnCommitStore;
        for thread_id in self
            .dirs
            .bindings
            .read()
            .map_err(|_| "Thread binding lock poisoned")?
            .keys()
        {
            let commits = self
                .store
                .list_commits(thread_id)
                .map_err(|error| error.to_string())?;
            let owned = commits
                .into_iter()
                .filter(|commit| &commit.session_id == session_id)
                .collect::<Vec<_>>();
            git_turn_changes::require_settled_publications(&owned)?;
        }
        Ok(())
    }
}
