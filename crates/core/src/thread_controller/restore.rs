use super::CreateThreadRequest;
use super::ThreadController;
use super::command_thread_id;
use super::validate_thread_title;
use crate::CoreError;
use crate::RestoreMessageRequest;
use crate::ThreadSnapshot;
use crate::ThreadWorktreeBinder;
use crate::ThreadWorktreeBindingRequest;
use ash_history::HistoryPrefix;
use ash_history::StoredEvent;
use ash_protocol::MessageBoundary;
use ash_protocol::MessageCheckpoint;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_protocol::WorkspaceCheckpoint;
use std::sync::Arc;

impl ThreadController {
    pub fn thread_history_state(
        &self,
        thread_id: &ThreadId,
    ) -> Result<ash_protocol::ThreadHistoryState, CoreError> {
        let snapshot = self.read_thread(thread_id)?;
        let idle = history_is_idle(&snapshot)
            && !matches!(
                history_workspace(&snapshot),
                WorkspaceCheckpoint::Unavailable { .. }
            );
        Ok(ash_protocol::ThreadHistoryState {
            sequence: snapshot.sequence,
            can_undo: idle && undo_checkpoint(&snapshot).is_some(),
            can_redo: idle && !snapshot.history_redo.is_empty(),
        })
    }

    pub fn move_thread_history(
        &self,
        request: core_api::MoveThreadHistoryRequest,
    ) -> Result<ThreadSnapshot, CoreError> {
        use super::BatchCommand;
        use ash_history::ThreadCommandReceipt;
        use ash_protocol::HistoryDirection;
        use ash_protocol::ThreadCommand;
        use ash_protocol::ThreadHistoryCheckpoint;
        self.mutate_thread(&request.thread_id, |snapshot| {
            let command = ThreadCommand::MoveHistory {
                direction: request.direction,
                expected_sequence: request.expected_sequence,
            };
            if let Some(previous) = snapshot.commands.iter().find(|previous| previous.receipt.command_id == request.command_id) {
                if previous.receipt.command != command {
                    return Err(CoreError::CommandConflict);
                }
                return Ok(snapshot.clone());
            }
            super::validate_thread_expectation(
                core_api::SequenceExpectation::Exact(request.expected_sequence), snapshot.sequence,
            )?;
            if !history_is_idle(snapshot) {
                return Err(CoreError::InvalidInput("history can only move in an idle active Thread".into()));
            }
            let current_workspace = history_workspace(snapshot);
            if matches!(current_workspace, WorkspaceCheckpoint::Unavailable { .. }) {
                return Err(CoreError::InvalidInput("current history file checkpoint is unavailable".into()));
            }
            let previous_prefix = HistoryPrefix { events: self.store.load(&request.thread_id)? };
            let previous = ThreadHistoryCheckpoint {
                prefix: previous_prefix.reference().map_err(CoreError::Journal)?,
                workspace: current_workspace,
            };
            let mut prefixes = vec![previous_prefix];
            let target = match request.direction {
                HistoryDirection::Undo => {
                    let point = undo_checkpoint(snapshot).ok_or_else(|| CoreError::InvalidInput("no earlier request checkpoint is available".into()))?;
                    let events = self.source_history(snapshot, &point.source_thread_id)?;
                    let turn_start = events.iter()
                        .find(|event| matches!(&event.event, ThreadEvent::TurnAccepted { turn_id, .. } if turn_id == &point.turn_id))
                        .ok_or_else(|| CoreError::Journal("request checkpoint has no Turn acceptance".into()))?
                        .sequence;
                    let prefix = HistoryPrefix {
                        events: events.into_iter().take_while(|event| event.sequence < turn_start).collect(),
                    };
                    let target = ThreadHistoryCheckpoint {
                        prefix: prefix.reference().map_err(CoreError::Journal)?,
                        workspace: point.workspace.clone(),
                    };
                    prefixes.push(prefix);
                    target
                }
                HistoryDirection::Redo => snapshot.history_redo.last().cloned()
                    .ok_or_else(|| CoreError::InvalidInput("no redo checkpoint is available".into()))?,
            };
            let (next, batch) = self.project_batch_with_history(
                Some(snapshot.clone()), &request.thread_id,
                vec![ThreadEvent::ThreadHistoryMoved {
                    thread_id: request.thread_id.clone(), direction: request.direction,
                    target: target.clone(), previous: previous.clone(),
                }],
                BatchCommand::AtEvent {
                    index: 0,
                    receipt: ThreadCommandReceipt { command_id: request.command_id.clone(), command },
                },
                prefixes,
            )?;
            let source = self.checkpoint_sources.read()
                .map_err(|_| CoreError::Journal("checkpoint source lock poisoned".into()))?
                .get(&request.thread_id).and_then(std::sync::Weak::upgrade);
            let mut restoration = if matches!((&previous.workspace, &target.workspace), (WorkspaceCheckpoint::NoFiles, WorkspaceCheckpoint::NoFiles)) {
                None
            } else {
                let source = source.ok_or_else(|| CoreError::Journal("Thread file checkpoint owner is unavailable".into()))?;
                Some(source.restore(&request, &previous.workspace, &target.workspace)?)
            };
            self.commit_batch(&batch)?;
            *snapshot = next;
            if let Some(restoration) = &mut restoration { restoration.commit(); }
            Ok(snapshot.clone())
        })
    }

    pub(crate) fn read_history_prefix(
        &self,
        reference: &ash_protocol::HistoryPrefixRef,
    ) -> Result<Arc<ThreadSnapshot>, CoreError> {
        crate::history::HistoryReader::new(self.store.as_ref(), &[]).resolve(reference)
    }

    pub fn message_checkpoints(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<MessageCheckpoint>, CoreError> {
        let snapshot = self.read_thread(thread_id)?;
        Ok(snapshot
            .items
            .iter()
            .filter_map(|item| snapshot.message_checkpoints.get(item.item_id()).cloned())
            .collect())
    }

    pub fn read_thread_at_sequence(
        &self,
        thread_id: &ThreadId,
        sequence: u64,
    ) -> Result<ThreadSnapshot, CoreError> {
        self.load_snapshot_at_sequence(thread_id, sequence)
    }

    pub fn restore_message(
        &self,
        binder: &dyn ThreadWorktreeBinder,
        request: RestoreMessageRequest,
    ) -> Result<ThreadSnapshot, CoreError> {
        validate_thread_title(&request.command_id, &request.title)?;
        let thread_id = command_thread_id("restore", &request.command_id)?;
        if let Some(binding) = self.store.read_thread_binding(&thread_id)? {
            if matches!(&binding.origin, ThreadOrigin::Message { parent_thread_id, item_id, boundary, .. }
                if parent_thread_id == &request.source_thread_id && item_id == &request.item_id && boundary == &request.boundary)
            {
                let existing = self.read_thread(&thread_id)?;
                if existing.title == request.title {
                    return Ok(existing);
                }
            }
            return Err(CoreError::CommandConflict);
        }
        let source = self.read_thread(&request.source_thread_id)?;
        let point = source
            .message_checkpoints
            .get(&request.item_id)
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "this message has no recorded restoration checkpoint".into(),
                )
            })?;
        if let WorkspaceCheckpoint::Unavailable { reason } = &point.workspace {
            return Err(CoreError::InvalidInput(format!(
                "message file checkpoint is unavailable: {reason}"
            )));
        }
        let sequence = match request.boundary {
            MessageBoundary::Before => point.source_sequence.checked_sub(1).ok_or_else(|| {
                CoreError::Journal("message boundary precedes Thread creation".into())
            })?,
            MessageBoundary::After => point.after_sequence,
        };
        let events = self.source_history(&source, &point.source_thread_id)?;
        let prefix = HistoryPrefix {
            events: events
                .into_iter()
                .take_while(|event| event.sequence <= sequence)
                .collect(),
        };
        let reference = prefix.reference().map_err(CoreError::Journal)?;
        let origin = ThreadOrigin::Message {
            parent_thread_id: source.thread_id.clone(),
            parent_sequence: source.sequence,
            item_id: request.item_id,
            boundary: request.boundary,
            workspace: point.workspace.clone(),
        };
        binder.provision(&ThreadWorktreeBindingRequest {
            session_id: source.session_id.clone(),
            thread_id: thread_id.clone(),
            origin: origin.clone(),
            branch_name: None,
        })?;
        self.create_thread_with_history(
            CreateThreadRequest {
                agent_id: source.agent_id.clone(),
                origin,
                agent: source.agent_configuration().cloned(),
                session_id: source.session_id,
                thread_id: thread_id.clone(),
                title: request.title,
                execution_target: source.execution_target.clone(),
            },
            vec![ThreadEvent::HistoryPrefixBound {
                thread_id,
                prefix: reference,
            }],
            vec![prefix],
        )
    }

    pub(super) fn source_history(
        &self,
        snapshot: &ThreadSnapshot,
        source_thread_id: &ThreadId,
    ) -> Result<Vec<StoredEvent>, CoreError> {
        if source_thread_id == &snapshot.thread_id {
            return self.store.load(source_thread_id).map_err(CoreError::from);
        }
        let reference = snapshot
            .history_sources
            .get(source_thread_id)
            .ok_or_else(|| {
                CoreError::Journal("message source is not part of the retained history".into())
            })?;
        self.store
            .load_history_prefix(reference)
            .map(|prefix| prefix.events)
            .map_err(CoreError::from)
    }
}

fn history_workspace(snapshot: &ThreadSnapshot) -> WorkspaceCheckpoint {
    snapshot
        .history_workspace
        .clone()
        .or_else(|| {
            snapshot.items.iter().rev().find_map(|item| {
                snapshot
                    .message_checkpoints
                    .get(item.item_id())
                    .map(|point| point.workspace.clone())
            })
        })
        .unwrap_or(WorkspaceCheckpoint::NoFiles)
}

fn history_is_idle(snapshot: &ThreadSnapshot) -> bool {
    snapshot.status == ash_protocol::ThreadStatus::Active
        && snapshot.turns.iter().all(|turn| {
            matches!(
                turn.status,
                ash_protocol::TurnStatus::Completed
                    | ash_protocol::TurnStatus::Failed
                    | ash_protocol::TurnStatus::Interrupted
            )
        })
}

fn undo_checkpoint(snapshot: &ThreadSnapshot) -> Option<&MessageCheckpoint> {
    let turn = snapshot.turns.last()?;
    snapshot.items.iter().find_map(|item| {
        if item.turn_id() == &turn.turn_id {
            snapshot
                .message_checkpoints
                .get(item.item_id())
                .filter(|point| !matches!(point.workspace, WorkspaceCheckpoint::Unavailable { .. }))
        } else {
            None
        }
    })
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod tests;
