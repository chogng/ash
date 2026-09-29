use super::ThreadPresentationEvent;
use super::presentation::ActiveTurnUpdate;
use super::presentation::evaluate_active_turn;
use super::presentation::recover_active_turn;
use super::transcript::StreamDisplay;
use super::transcript::TranscriptCell;
use super::transcript::TranscriptCellId;
use super::transcript::TranscriptModel;
use crate::thread::transcript::CellView;
use crate::thread::transcript::MessageRole;
use ash_protocol::ApprovalMode;
use ash_protocol::ThreadId;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TurnApprovalModes {
    pub(crate) current: Option<ApprovalMode>,
    pub(crate) next: ApprovalMode,
}

impl Default for TurnApprovalModes {
    fn default() -> Self {
        Self {
            current: None,
            next: ApprovalMode::AskPermissions,
        }
    }
}

impl From<ApprovalMode> for TurnApprovalModes {
    fn from(next: ApprovalMode) -> Self {
        Self {
            current: None,
            next,
        }
    }
}

/// Owns current-Turn lifecycle inputs and retains ordered transcripts across Thread switches.
#[derive(Debug, Default)]
pub(crate) struct ThreadState {
    active_turn: Option<TurnId>,
    approval_modes: TurnApprovalModes,
    transcript: TranscriptModel,
    stream: StreamDisplay,
    inactive_transcripts: BTreeMap<ThreadId, TranscriptModel>,
}

impl ThreadState {
    pub(crate) fn switch_transcript(&mut self, previous: &ThreadId, next: &ThreadId) {
        if previous == next {
            return;
        }
        let outgoing = std::mem::take(&mut self.transcript);
        self.inactive_transcripts.insert(previous.clone(), outgoing);
        self.transcript = self.inactive_transcripts.remove(next).unwrap_or_default();
        self.stream.install(self.transcript.cells());
    }

    pub(crate) fn active_turn(&self) -> Option<&TurnId> {
        self.active_turn.as_ref()
    }

    pub(crate) fn set_active_turn(&mut self, turn_id: TurnId) {
        self.active_turn = Some(turn_id);
    }

    pub(crate) fn set_active_turn_if_idle(&mut self, turn_id: TurnId) {
        if self.active_turn.is_none() {
            self.active_turn = Some(turn_id);
        }
    }

    pub(crate) fn clear_active_turn(&mut self) {
        self.finish_stream();
        self.active_turn = None;
    }

    pub(crate) fn sync_active_turn(&mut self, turns: &[Turn]) -> Vec<ActiveTurnUpdate> {
        if self.active_turn.is_none() {
            self.active_turn = recover_active_turn(turns);
        }
        let prior_turn = self.active_turn.clone();
        let mut updates = vec![evaluate_active_turn(&mut self.active_turn, turns)];
        if self.active_turn.is_none()
            && let Some(prior_turn) = prior_turn.as_ref()
        {
            self.stream.finish_turn(prior_turn);
        }
        if self.active_turn.is_none() {
            self.active_turn = recover_active_turn(turns);
            if self.active_turn.is_some() {
                updates.push(evaluate_active_turn(&mut self.active_turn, turns));
            }
        }
        updates
    }

    pub(crate) fn approval_modes(&self) -> TurnApprovalModes {
        self.approval_modes
    }

    pub(crate) fn approval_mode(&self) -> ApprovalMode {
        self.approval_modes.next
    }

    pub(crate) fn cycle_approval_mode(&mut self) {
        self.approval_modes.next = match self.approval_modes.next {
            ApprovalMode::AskPermissions => ApprovalMode::AutoReview,
            ApprovalMode::AutoReview => ApprovalMode::BypassPermissions,
            ApprovalMode::BypassPermissions => ApprovalMode::AskPermissions,
        };
    }

    #[cfg(test)]
    pub(crate) fn set_next_approval_mode(&mut self, approval_mode: ApprovalMode) {
        self.approval_modes.next = approval_mode;
    }

    pub(crate) fn set_current_approval_mode(&mut self, approval_mode: Option<ApprovalMode>) {
        self.approval_modes.current = approval_mode;
    }

    #[cfg(test)]
    pub(crate) fn messages(&self) -> Vec<CellView<'_>> {
        self.transcript.views(&BTreeSet::new(), None)
    }

    pub(crate) fn has_user_message(&self) -> bool {
        self.transcript.has_user_message()
    }

    pub(crate) fn latest_agent_response(&self) -> Option<&str> {
        self.transcript.latest_agent_response()
    }

    pub(crate) fn views(
        &self,
        expanded: &BTreeSet<TranscriptCellId>,
        selected: Option<&TranscriptCellId>,
    ) -> Vec<CellView<'_>> {
        self.transcript.views(expanded, selected)
    }

    pub(crate) fn visible_views(
        &self,
        expanded: &BTreeSet<TranscriptCellId>,
        selected: Option<&TranscriptCellId>,
    ) -> Vec<CellView<'_>> {
        self.stream
            .visible(self.transcript.views(expanded, selected))
    }

    pub(crate) fn stream_deadline(&self) -> Option<Instant> {
        self.stream.deadline()
    }
    pub(crate) fn advance_stream(&mut self, now: Instant) -> bool {
        self.stream.advance(now)
    }
    pub(crate) fn finish_stream(&mut self) {
        if let Some(turn_id) = self.active_turn.as_ref() {
            self.stream.finish_turn(turn_id);
        } else {
            self.stream.finish_all();
        }
    }

    pub(crate) fn cells(&self) -> &[TranscriptCell] {
        self.transcript.cells()
    }

    pub(crate) fn history_prefix(&self) -> &[TranscriptCell] {
        self.transcript.history_prefix(self.active_turn.as_ref())
    }

    pub(crate) fn details(&self, cell_id: &TranscriptCellId) -> Option<String> {
        self.transcript.details(cell_id)
    }

    pub(crate) fn update(&mut self, event: ThreadPresentationEvent) {
        self.update_at(event, Instant::now());
    }

    fn update_at(&mut self, event: ThreadPresentationEvent, now: Instant) {
        match event {
            ThreadPresentationEvent::TranscriptSnapshotReceived(snapshot) => {
                self.transcript.replace(snapshot);
                self.stream.install(self.transcript.cells());
            }
            ThreadPresentationEvent::TranscriptHistoryPageReceived(page) => {
                self.transcript.prepend_history(page);
                self.stream.install(self.transcript.cells());
            }
            ThreadPresentationEvent::TranscriptUpdateReceived(update) => {
                self.transcript.apply(*update);
                self.stream.update(self.transcript.cells(), now);
            }
            ThreadPresentationEvent::UserSubmitted(text) => {
                self.transcript.push_message(MessageRole::User, text);
            }
            ThreadPresentationEvent::CommandSubmitted {
                command,
                completion,
            } => {
                self.transcript.command_submitted(command, completion);
            }
            ThreadPresentationEvent::CommandStarted(command) => {
                self.transcript.command_started(command);
            }
            ThreadPresentationEvent::CommandCompleted { command, result } => {
                self.transcript.command_completed(
                    command,
                    result,
                    super::transcript::CommandStatus::Succeeded,
                );
            }
            ThreadPresentationEvent::CommandFailed { command, error } => {
                self.transcript.command_failed(command, error);
            }
            ThreadPresentationEvent::NoticeReceived(text) => {
                self.transcript.push_notice(text);
            }
            ThreadPresentationEvent::FailureReported(text) => {
                self.transcript.push_error(text);
            }
            ThreadPresentationEvent::Interrupted => {
                self.finish_stream();
                self.transcript.push_notice("turn interrupted".into());
            }
            ThreadPresentationEvent::Cleared => {
                self.transcript.clear();
                self.stream.install(&[]);
            }
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
