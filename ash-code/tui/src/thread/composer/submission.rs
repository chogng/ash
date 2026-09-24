use crate::thread::composer::ChatInput;
use crate::thread::composer::ChatInputOutcome;
use crate::thread::composer::ChatInputQueueOutcome;
use crate::thread::composer::ChatSubmission;
use crate::thread::composer::CompletionView;
use crate::thread::composer::QueuedChatInput;
use crate::thread::composer::SlashCommandInvocation;
use crate::thread::composer::Steer;
use crate::thread::composer::SteerId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

pub(crate) struct ChatComposerView<'a> {
    input: &'a ChatInput,
}

impl ChatComposerView<'_> {
    pub(super) fn input(&self) -> &str {
        self.input.text()
    }

    pub(super) fn input_cursor_width(&self) -> usize {
        self.input.cursor_display_width()
    }

    pub(super) fn input_cursor_line(&self) -> usize {
        self.input.cursor_line()
    }

    pub(super) fn input_prompt(&self) -> &'static str {
        self.input.prompt()
    }

    pub(super) fn input_desired_height(&self, available_width: u16) -> u16 {
        self.input.desired_height(available_width)
    }

    pub(super) fn history_status(&self) -> Option<String> {
        self.input.history_status()
    }

    pub(super) fn searching_history(&self) -> bool {
        self.input.searching_history()
    }

    pub(super) fn input_completion(&self) -> Option<CompletionView<'_>> {
        self.input.completion()
    }

    pub(super) fn argument_hint(&self) -> Option<&str> {
        self.input.argument_hint()
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ChatComposerOutcome {
    Command(SlashCommandInvocation),
    Consumed,
    SubmissionRejected(String),
    Queued(QueuedChatInput),
    Submit(ChatSubmission),
    Unhandled,
}

/// Coordinates ChatInput submission targets while leaving menus and feature flows to App.
#[derive(Debug)]
pub(crate) struct ChatComposer {
    steer: Steer,
}

impl ChatComposer {
    pub(crate) fn new() -> Self {
        Self {
            steer: Steer::default(),
        }
    }

    pub(crate) fn handle_key(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
    ) -> ChatComposerOutcome {
        self.handle_key_with_submission_target(input, key, SubmissionTarget::Start)
    }

    pub(crate) fn handle_active_turn_key(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
    ) -> ChatComposerOutcome {
        if !input.searching_history()
            && key.code == KeyCode::Enter
            && key.modifiers == KeyModifiers::CONTROL
            && input.completion().is_none()
            && input.accepts_submission_key()
        {
            return self.steer_current_input(input);
        }
        self.handle_key_with_submission_target(input, key, SubmissionTarget::Queue)
    }

    pub(crate) fn handle_queued_turn_key(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
    ) -> ChatComposerOutcome {
        self.handle_key_with_submission_target(input, key, SubmissionTarget::Queue)
    }

    fn handle_key_with_submission_target(
        &mut self,
        input: &mut ChatInput,
        key: KeyEvent,
        submission_target: SubmissionTarget,
    ) -> ChatComposerOutcome {
        if !input.searching_history()
            && submission_target == SubmissionTarget::Queue
            && key.code == KeyCode::Enter
            && key.modifiers.is_empty()
            && input.completion().is_none()
            && input.accepts_submission_key()
        {
            return self.queue_current_input(input);
        }
        map_chat_input_outcome(input.handle_key(key))
    }

    fn steer_current_input(&mut self, input: &mut ChatInput) -> ChatComposerOutcome {
        if input.submission_contains_skill() {
            return ChatComposerOutcome::SubmissionRejected(
                "A running Turn cannot change its Skill; queue the message with Enter or wait for the next Turn"
                    .into(),
            );
        }
        map_chat_input_outcome(input.submit_current())
    }

    #[cfg(test)]
    pub(crate) fn insert_text(&mut self, input: &mut ChatInput, text: &str) {
        input.insert_text(text);
    }

    pub(crate) fn handle_paste(
        &mut self,
        input: &mut ChatInput,
        pasted: String,
    ) -> Result<(), String> {
        input.handle_paste(pasted)
    }

    pub(crate) fn attach_image_bytes(
        &mut self,
        input: &mut ChatInput,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        input.attach_image_bytes(bytes)
    }

    pub(crate) fn view<'a>(&self, input: &'a ChatInput) -> ChatComposerView<'a> {
        ChatComposerView { input }
    }

    pub(crate) fn activate_completion(
        &mut self,
        input: &mut ChatInput,
        index: usize,
    ) -> Option<ChatComposerOutcome> {
        input.activate_completion(index).map(map_chat_input_outcome)
    }

    pub(crate) fn begin_steer(&mut self, text: String) -> SteerId {
        self.steer.push(text)
    }

    pub(crate) fn finish_steer(&mut self, id: SteerId) -> bool {
        self.steer.remove(id)
    }

    pub(crate) fn clear_steers(&mut self) {
        self.steer.clear();
    }

    fn queue_current_input(&mut self, input: &mut ChatInput) -> ChatComposerOutcome {
        match input.queue_current() {
            ChatInputQueueOutcome::Command(command) => ChatComposerOutcome::Command(command),
            ChatInputQueueOutcome::Consumed => ChatComposerOutcome::Consumed,
            ChatInputQueueOutcome::Queued(input) => ChatComposerOutcome::Queued(input),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SubmissionTarget {
    Start,
    Queue,
}

fn map_chat_input_outcome(outcome: ChatInputOutcome) -> ChatComposerOutcome {
    match outcome {
        ChatInputOutcome::Command(command) => ChatComposerOutcome::Command(command),
        ChatInputOutcome::Consumed => ChatComposerOutcome::Consumed,
        ChatInputOutcome::Submit(prompt) => ChatComposerOutcome::Submit(prompt),
        ChatInputOutcome::Unhandled => ChatComposerOutcome::Unhandled,
    }
}

#[cfg(test)]
#[path = "submission_tests.rs"]
mod tests;
