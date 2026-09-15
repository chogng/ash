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

impl ThreadController {
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
        })?;
        self.create_thread_with_history(
            CreateThreadRequest {
                agent_id: source.agent_id.clone(),
                origin,
                agent: source.agent_configuration().cloned(),
                session_id: source.session_id,
                thread_id: thread_id.clone(),
                title: request.title,
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

#[cfg(test)]
#[path = "restore_tests.rs"]
mod tests;
