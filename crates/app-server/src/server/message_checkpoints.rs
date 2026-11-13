use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use ash_protocol::RepositoryCheckpoint;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::WorkspaceCheckpoint;
use core_api::CheckpointCapture;
use core_api::CoreError;
use core_api::MessageCheckpointSource;
use git_turn_changes::MessageCaptureTarget;
use git_turn_changes::MessageCaptureTurn;
use git_turn_changes::TurnChangeLedger;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use worktree::ManagedDirKind;

struct CapturedWorkspace {
    ledger: TurnChangeLedger,
    workspace: WorkspaceCheckpoint,
    committed: AtomicBool,
    lease: std::sync::Mutex<Option<git_turn_changes::WriteCheckpointLease>>,
}

impl CheckpointCapture for CapturedWorkspace {
    fn workspace(&self) -> &WorkspaceCheckpoint {
        &self.workspace
    }
    fn commit(&self) {
        self.committed.store(true, Ordering::Release);
        self.lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

impl Drop for CapturedWorkspace {
    fn drop(&mut self) {
        if self.committed.load(Ordering::Acquire) {
            return;
        }
        if let WorkspaceCheckpoint::Git { repositories, .. } = &self.workspace {
            for checkpoint in repositories {
                if let Err(error) = self.ledger.release_message(checkpoint.clone()) {
                    log::error!("failed to release uncommitted message checkpoint: {error}");
                }
            }
        }
    }
}

impl MessageCheckpointSource for GitTurnChangesRuntime {
    fn restore(
        &self,
        request: &core_api::MoveThreadHistoryRequest,
        expected: &WorkspaceCheckpoint,
        target: &WorkspaceCheckpoint,
    ) -> Result<Box<dyn core_api::WorkspaceRestoration>, CoreError> {
        self.prepare_history_restore(request, expected, target)
    }
    fn capture(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item: &ThreadItem,
        event_id: &str,
    ) -> Result<Box<dyn CheckpointCapture>, CoreError> {
        let refresh = match item {
            ThreadItem::ToolResult { tool_call_id, .. } => self
                .tool_result_refreshes
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&(thread_id.clone(), turn_id.clone(), tool_call_id.clone()))
                .map(|session_id| MessageCaptureTurn {
                    session_id,
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                }),
            _ => None,
        };
        self.capture_workspace(thread_id, event_id, refresh)
    }

    fn release(&self, checkpoint: &RepositoryCheckpoint) -> Result<(), CoreError> {
        if !checkpoint.reference.starts_with("refs/ash/messages/") {
            return Err(CoreError::Journal(
                "checkpoint ref is outside the message namespace".into(),
            ));
        }
        self.ledger
            .release_message(checkpoint.clone())
            .map_err(|error| CoreError::Journal(error.to_string()))
    }
}

impl GitTurnChangesRuntime {
    pub(super) fn capture_workspace(
        &self,
        thread_id: &ThreadId,
        event_id: &str,
        mut refresh: Option<MessageCaptureTurn>,
    ) -> Result<Box<dyn CheckpointCapture>, CoreError> {
        if self
            .history_restoration_pending(thread_id)
            .map_err(CoreError::Journal)?
        {
            return Err(CoreError::WorkspaceCheckpointConflict);
        }
        let binding = self.binding(thread_id).ok_or_else(|| {
            CoreError::Journal("message checkpoint requires a managed Thread directory".into())
        })?;
        let lease = self
            .write_lifecycles
            .try_checkpoint(thread_id)
            .map_err(CoreError::Journal)?;
        let workspace = if lease.is_none() {
            WorkspaceCheckpoint::Unavailable {
                reason: "A write-capable Tool was still running when this message was recorded."
                    .into(),
            }
        } else if binding.kind() == ManagedDirKind::Directory {
            match self
                .dirs
                .worktrees
                .capture_directory_checkpoint(binding.dir())
            {
                Ok(digest) => WorkspaceCheckpoint::Directory {
                    source_dir_id: self.dirs.id.to_string(),
                    digest,
                },
                Err(error) => WorkspaceCheckpoint::Unavailable {
                    reason: format!("Directory snapshot capture failed: {error}"),
                },
            }
        } else {
            let targets = binding
                .repositories()
                .iter()
                .map(|repository| MessageCaptureTarget {
                    repository_id: repository.repository_id().to_string(),
                    worktree_root: repository.worktree_root().to_path_buf(),
                    relative_path: repository.relative_path().to_path_buf(),
                    target_branch: repository.target_branch().map(ToOwned::to_owned),
                    target_head: repository.target_head().to_string(),
                    target_unborn: repository.target_unborn(),
                })
                .collect();
            match self
                .ledger
                .capture_message(event_id.to_string(), targets, refresh.clone())
            {
                Ok(capture) => {
                    refresh = None;
                    match capture.refreshed {
                        Ok(records) => self.publish(&records),
                        Err(error) => log::warn!("Tool Result ChangeSet refresh failed: {error}"),
                    }
                    WorkspaceCheckpoint::Git {
                        source_dir_id: self.dirs.id.to_string(),
                        repositories: capture.checkpoints,
                    }
                }
                Err(error) => WorkspaceCheckpoint::Unavailable {
                    reason: format!("File snapshot capture failed: {error}"),
                },
            }
        };
        // A failed or fenced message capture must not swallow the observer's live refresh.
        if let Some(turn) = refresh {
            match self
                .ledger
                .refresh_turn(turn.session_id, turn.thread_id, turn.turn_id)
            {
                Ok(records) => self.publish(&records),
                Err(error) => log::warn!("Tool Result ChangeSet refresh failed: {error}"),
            }
        }
        Ok(Box::new(CapturedWorkspace {
            ledger: self.ledger.clone(),
            workspace,
            committed: AtomicBool::new(false),
            lease: std::sync::Mutex::new(lease),
        }))
    }
}
