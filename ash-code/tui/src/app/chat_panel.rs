use super::top_tip::TopTip;
use crate::host::clipboard::ClipboardImageFingerprint;
use crate::status::StatusLineModel;
use crate::thread::ThreadRequestIdentity;
use crate::thread::ThreadRequestKind;
use crate::thread::ThreadRequestResponse;
use crate::thread::TurnActivity;
use crate::thread::composer::ChatComposer;
use crate::thread::composer::ChatComposerOutcome;
use crate::thread::composer::ChatComposerView;
use crate::thread::composer::ChatInput;
use crate::thread::composer::SteerId;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::approval::ApprovalOutcome;
use crate::thread::interaction::approval::ApprovalView;
use crate::thread::interaction::query::Query;
use crate::thread::interaction::query::QueryOutcome;
use crate::thread::interaction::query::QueryView;
use ash_protocol::RequestId;
use ash_protocol::TurnId;
use crossterm::event::KeyEvent;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputMode {
    Start,
    Queue,
    Steer,
}

#[derive(Debug)]
pub(crate) struct ChatPanel {
    composer: ChatComposer,
    approval: Option<Approval>,
    query: Option<Query>,
    input_mode: InputMode,
    status_line: StatusLineModel,
    top_tip: TopTip,
}

impl ChatPanel {
    pub(crate) fn new() -> Self {
        Self {
            composer: ChatComposer::new(),
            approval: None,
            query: None,
            input_mode: InputMode::Start,
            status_line: StatusLineModel::new(),
            top_tip: TopTip::new(),
        }
    }

    pub(crate) fn handle_composer_key(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
    ) -> ChatComposerOutcome {
        match self.input_mode {
            InputMode::Start => self.composer.handle_key(input, key),
            InputMode::Queue => self.composer.handle_queued_turn_key(input, key),
            InputMode::Steer => self.composer.handle_active_turn_key(input, key),
        }
    }

    pub(crate) fn composer_view<'a>(&self, input: &'a ChatInput) -> ChatComposerView<'a> {
        self.composer.view(input)
    }

    pub(crate) fn handle_new_session_key(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
    ) -> ChatComposerOutcome {
        // Keep the complete draft until session creation succeeds, including attachment bindings.
        self.composer.handle_queued_turn_key(input, key)
    }

    pub(crate) fn activate_completion(
        &mut self,
        input: &mut ChatInput,
        index: usize,
    ) -> Option<ChatComposerOutcome> {
        self.composer.activate_completion(input, index)
    }

    #[cfg(test)]
    pub(crate) fn insert_text(&mut self, input: &mut ChatInput, text: &str) {
        self.composer.insert_text(input, text);
    }

    pub(crate) fn handle_input_paste(
        &mut self,
        input: &mut ChatInput,
        pasted: String,
    ) -> Result<(), String> {
        self.composer.handle_paste(input, pasted)
    }

    pub(crate) fn attach_image_bytes(
        &mut self,
        input: &mut ChatInput,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        self.composer.attach_image_bytes(input, bytes)
    }

    pub(crate) fn begin_steer(&mut self, text: String) -> SteerId {
        self.composer.begin_steer(text)
    }

    pub(crate) fn finish_steer(&mut self, steer_id: SteerId) {
        self.composer.finish_steer(steer_id);
    }

    pub(crate) fn clear_steers(&mut self) {
        self.composer.clear_steers();
    }

    pub(crate) fn is_steering(&self) -> bool {
        self.input_mode == InputMode::Steer
    }

    pub(crate) fn start_input(&mut self) {
        self.input_mode = InputMode::Start;
    }

    pub(crate) fn queue_input(&mut self) {
        self.input_mode = InputMode::Queue;
    }

    pub(crate) fn steer_input(&mut self) {
        self.input_mode = InputMode::Steer;
    }

    pub(crate) fn apply_turn_activity(&mut self, activity: TurnActivity) {
        self.input_mode = match activity {
            TurnActivity::Working => InputMode::Steer,
            TurnActivity::Starting
            | TurnActivity::WaitingForApproval
            | TurnActivity::WaitingForUserInput
            | TurnActivity::WaitingForCapability
            | TurnActivity::Cancelling => InputMode::Queue,
        };
    }

    pub(crate) fn request_active(&self) -> bool {
        self.approval.is_some() || self.query.is_some()
    }

    pub(crate) fn approval_view(&self) -> Option<ApprovalView<'_>> {
        self.approval.as_ref().map(Approval::view)
    }

    pub(crate) fn query_view(&self) -> Option<QueryView<'_>> {
        self.query.as_ref().map(Query::view)
    }

    pub(crate) fn show_approval(&mut self, approval: Approval) {
        self.query = None;
        self.approval = Some(approval);
    }

    pub(crate) fn show_query(&mut self, query: Query) {
        self.approval = None;
        self.query = Some(query);
    }

    pub(crate) fn handle_request_key(
        &mut self,
        key: KeyEvent,
    ) -> Option<Option<ThreadRequestResponse>> {
        if let Some(approval) = self.approval.as_mut() {
            let outcome = approval.handle_key(key);
            return Some(match outcome {
                ApprovalOutcome::Respond(decision) => Some(approval.response(decision)),
                ApprovalOutcome::Consumed | ApprovalOutcome::Unhandled => None,
            });
        }
        if let Some(query) = self.query.as_mut() {
            let outcome = query.handle_key(key);
            return Some(match outcome {
                QueryOutcome::Completed(answers) => Some(query.response(answers)),
                QueryOutcome::Consumed | QueryOutcome::Unhandled => None,
            });
        }
        None
    }

    pub(crate) fn activate_approval(&mut self, index: usize) -> Option<ThreadRequestResponse> {
        let approval = self.approval.as_mut()?;
        match approval.activate(index) {
            ApprovalOutcome::Respond(decision) => Some(approval.response(decision)),
            ApprovalOutcome::Consumed | ApprovalOutcome::Unhandled => None,
        }
    }

    pub(crate) fn activate_query_choice(&mut self, index: usize) -> Option<ThreadRequestResponse> {
        let query = self.query.as_mut()?;
        match query.activate(index) {
            QueryOutcome::Completed(answers) => Some(query.response(answers)),
            QueryOutcome::Consumed | QueryOutcome::Unhandled => None,
        }
    }

    pub(crate) fn handle_request_paste(&mut self, pasted: String) -> bool {
        if self.approval.is_some() {
            return true;
        }
        let Some(query) = self.query.as_mut() else {
            return false;
        };
        query.handle_paste(pasted);
        true
    }

    pub(crate) fn close_request(&mut self, request: &ThreadRequestIdentity) {
        match request.kind {
            ThreadRequestKind::Approval => {
                if self
                    .approval
                    .as_ref()
                    .is_some_and(|approval| approval.request_id() == &request.request_id)
                {
                    self.approval = None;
                }
            }
            ThreadRequestKind::Query => {
                if self
                    .query
                    .as_ref()
                    .is_some_and(|query| query.request_id() == &request.request_id)
                {
                    self.query = None;
                }
            }
        }
    }

    pub(crate) fn fail_request(&mut self, request: &ThreadRequestIdentity, error: String) {
        match request.kind {
            ThreadRequestKind::Approval => {
                if let Some(approval) = self.approval.as_mut()
                    && approval.request_id() == &request.request_id
                {
                    approval.submission_failed(error);
                }
            }
            ThreadRequestKind::Query => {
                if let Some(query) = self.query.as_mut()
                    && query.request_id() == &request.request_id
                {
                    query.submission_failed(error);
                }
            }
        }
    }

    pub(crate) fn reconcile_request(&mut self, pending: Option<&(TurnId, RequestId)>) {
        let approval_is_current = self.approval.as_ref().is_some_and(|approval| {
            pending
                .is_some_and(|(turn_id, request_id)| approval.matches_request(turn_id, request_id))
        });
        let query_is_current = self.query.as_ref().is_some_and(|query| {
            pending.is_some_and(|(turn_id, request_id)| query.matches_request(turn_id, request_id))
        });
        if !approval_is_current {
            self.approval = None;
        }
        if !query_is_current {
            self.query = None;
        }
    }

    pub(crate) fn status_line(&self) -> &StatusLineModel {
        &self.status_line
    }

    pub(crate) fn status_line_mut(&mut self) -> &mut StatusLineModel {
        &mut self.status_line
    }

    pub(crate) fn top_tip(&self) -> &TopTip {
        &self.top_tip
    }

    pub(crate) fn show_policy_tip(&mut self, now: Instant) {
        self.top_tip.show_policy_tip(now);
    }

    pub(crate) fn show_notice(&mut self, notice: String, now: Instant) {
        self.top_tip.show_notice(notice, now);
    }

    pub(crate) fn show_clipboard_image(
        &mut self,
        fingerprint: ClipboardImageFingerprint,
        now: Instant,
    ) {
        self.top_tip.show_clipboard_image(fingerprint, now);
    }

    pub(crate) fn clipboard_image_pasted(&mut self, fingerprint: ClipboardImageFingerprint) {
        self.top_tip.clipboard_image_pasted(fingerprint);
    }

    pub(crate) fn hide_clipboard_image(&mut self) {
        self.top_tip.hide_clipboard_image();
    }

    pub(crate) fn hide_navigation(&mut self) {
        self.top_tip.hide_navigation();
    }

    pub(crate) fn reset_top_tip(&mut self) {
        self.top_tip.reset();
    }

    pub(crate) fn poll_top_tip(&mut self, now: Instant, mode: crate::terminal::ScreenMode) -> bool {
        match mode {
            crate::terminal::ScreenMode::Fullscreen => self.top_tip.poll_fullscreen(now),
            crate::terminal::ScreenMode::Inline => self.top_tip.poll(now),
        }
    }
}
