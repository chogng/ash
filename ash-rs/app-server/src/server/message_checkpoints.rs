use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use git_turn_changes::MessageCaptureTarget;
use git_turn_changes::TurnChangeLedger;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use worktree::ManagedDirKind;
use core_api::CheckpointCapture;
use core_api::CoreError;
use core_api::MessageCheckpointSource;
use ash_protocol::ItemId;
use ash_protocol::RepositoryCheckpoint;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::WorkspaceCheckpoint;

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
    fn capture(
        &self,
        thread_id: &ThreadId,
        _: &TurnId,
        _: &ItemId,
        event_id: &str,
    ) -> Result<Box<dyn CheckpointCapture>, CoreError> {
        let binding = self.binding(thread_id).ok_or_else(|| {
            CoreError::Journal("message checkpoint requires a managed Thread directory".into())
        })?;
        let lease = self
            .write_lifecycles
            .try_checkpoint(thread_id)
            .map_err(CoreError::Journal)?;
        let workspace = if binding.kind() != ManagedDirKind::Git {
            WorkspaceCheckpoint::Unavailable {
                reason: "This directory has no immutable Git file snapshots.".into(),
            }
        } else if lease.is_none() {
            WorkspaceCheckpoint::Unavailable {
                reason: "A write-capable Tool was still running when this message was recorded."
                    .into(),
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
            match self.ledger.capture_message(event_id.to_string(), targets) {
                Ok(repositories) => WorkspaceCheckpoint::Git {
                    source_dir_id: self.dirs.id.to_string(),
                    repositories,
                },
                Err(error) => WorkspaceCheckpoint::Unavailable {
                    reason: format!("File snapshot capture failed: {error}"),
                },
            }
        };
        Ok(Box::new(CapturedWorkspace {
            ledger: self.ledger.clone(),
            workspace,
            committed: AtomicBool::new(false),
            lease: std::sync::Mutex::new(lease),
        }))
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
