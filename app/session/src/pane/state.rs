//! Retained state for one Session Pane.

use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorSelectionMode;
use ash_editor::CodeEditorStyle;
use ash_input_classifier::InputConversation;
use ash_input_classifier::InputHistoryEntry;
use ash_protocol::Thread;
use ash_protocol::ThreadItem;
use ash_protocol::TurnStatus;
use ash_slash_commands::SlashCommandCatalogError;
use ash_slash_commands::SlashCommandDefinition;
use ash_thread_transcript::ThreadTranscriptSnapshot;
use ash_thread_transcript::ThreadTranscriptUpdateEnvelope;
use ash_ui_components::ScrollCommand;
use serde_json::Value;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInputCompositionEvent;

use crate::ChatInput;
use crate::ChatInputInteractionView;
use crate::ComposerClassificationResult;
use crate::ComposerClassificationTask;
use crate::ComposerClassificationUpdate;
use crate::ComposerInteractionActivation;
use crate::ComposerModelOption;
use crate::ComposerRoute;
use crate::ComposerSubmission;
use crate::SelectionDirection;
use crate::line_capacity;
use crate::line_count;

use super::chat_widget::ChatWidgetState;

/// Complete retained state for one Agent Session Pane.
///
/// The product host supplies canonical Thread and transcript snapshots, mechanically assembled
/// transcript changes, and executes submissions. The pane owns the Thread and one ChatWidget as a
/// unit; the ChatWidget owns transcript, timeline scroll, and ChatInput state.
pub struct SessionPaneState {
    thread: Option<Thread>,
    chat_widget: ChatWidgetState,
}

impl Default for SessionPaneState {
    fn default() -> Self {
        Self::for_working_directory(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

impl SessionPaneState {
    pub fn for_working_directory(working_directory: impl Into<PathBuf>) -> Self {
        Self {
            thread: None,
            chat_widget: ChatWidgetState::for_working_directory(working_directory),
        }
    }

    pub const fn thread(&self) -> Option<&Thread> {
        self.thread.as_ref()
    }

    pub(crate) const fn chat_widget(&self) -> &ChatWidgetState {
        &self.chat_widget
    }

    const fn chat_input(&self) -> &ChatInput {
        self.chat_widget.input()
    }

    fn update_chat_input<R>(&mut self, update: impl FnOnce(&mut ChatInput) -> R) -> R {
        update(self.chat_widget.input_mut())
    }

    pub const fn timeline_scroll(&self) -> &crate::ThreadTimelineScroll {
        self.chat_widget.timeline_scroll()
    }

    pub fn timeline_scroll_mut(&mut self) -> &mut crate::ThreadTimelineScroll {
        self.chat_widget.timeline_scroll_mut()
    }

    pub fn composer_preferred_height(&self) -> f32 {
        self.chat_input().input().preferred_height()
    }

    pub fn selected_composer_text(&self) -> Option<&str> {
        self.chat_input().input().selected_text()
    }

    pub const fn composer_route(&self) -> ComposerRoute {
        self.chat_input().route()
    }

    /// Requests submission; pending inference resumes it only for the same input revision.
    pub fn request_composer_submission(&mut self) -> Option<ComposerSubmission> {
        self.update_chat_input(ChatInput::request_submission)
    }

    /// Next input deadline to include in the window event loop when its worker is available.
    pub fn composer_classification_deadline(&self) -> Option<Instant> {
        self.chat_input().classification_deadline()
    }

    /// Takes the latest due inference task. The host runs at most one task at a time.
    pub fn take_composer_classification_task(
        &mut self,
        now: Instant,
    ) -> Option<ComposerClassificationTask> {
        self.update_chat_input(|input| input.take_classification_task(now))
    }

    /// Applies a matching result and tells the host whether to redraw or complete submission.
    pub fn finish_composer_classification(
        &mut self,
        result: ComposerClassificationResult,
    ) -> ComposerClassificationUpdate {
        self.update_chat_input(|input| input.finish_classification(result))
    }

    pub fn set_composer_text(&mut self, text: impl Into<String>) {
        self.update_chat_input(|chat_input| chat_input.set_text(text));
    }

    pub fn set_composer_style(&mut self, style: CodeEditorStyle) {
        self.update_chat_input(|chat_input| chat_input.set_input_style(style));
    }

    pub fn set_composer_catalog(
        &mut self,
        slash_commands: Vec<SlashCommandDefinition>,
        models: Vec<ComposerModelOption>,
    ) -> Result<(), SlashCommandCatalogError> {
        self.update_chat_input(|chat_input| {
            chat_input.set_interaction_catalog(slash_commands, models)
        })
    }

    pub fn refresh_dir_catalog(&mut self) {
        self.update_chat_input(ChatInput::refresh_dir_catalog);
    }

    pub fn apply_composer_command(&mut self, command: CodeEditorCommand) {
        self.update_chat_input(|chat_input| chat_input.apply(command));
    }

    pub fn apply_composer_composition(&mut self, event: TextInputCompositionEvent) {
        self.update_chat_input(|chat_input| chat_input.apply_composition(event));
    }

    pub fn cancel_composer_composition(&mut self) {
        self.update_chat_input(ChatInput::cancel_composition);
    }

    pub fn accept_shell_suggestion(&mut self) -> bool {
        self.update_chat_input(ChatInput::accept_shell_suggestion)
    }

    pub fn dismiss_shell_suggestion(&mut self) -> bool {
        self.update_chat_input(ChatInput::dismiss_shell_suggestion)
    }

    pub fn has_shell_suggestion(&self) -> bool {
        self.chat_input().has_shell_suggestion()
    }

    pub fn connect_input_history(&mut self, client: message_history::MessageHistory) {
        self.update_chat_input(|input| input.connect_history(client));
    }

    pub fn input_history_unavailable(&mut self, error: String) {
        self.update_chat_input(|input| input.history_unavailable(error));
    }

    pub fn poll_input_history(&mut self) -> bool {
        self.update_chat_input(ChatInput::poll_history)
    }
    pub fn searching_input_history(&self) -> bool {
        self.chat_input().searching_history()
    }
    pub fn start_input_history_search(&mut self) {
        self.update_chat_input(ChatInput::start_history_search);
    }
    pub fn accept_input_history(&mut self) {
        self.update_chat_input(ChatInput::accept_history);
    }
    pub fn cancel_input_history(&mut self) {
        self.update_chat_input(ChatInput::cancel_history);
    }

    pub fn mark_agent_message_submitted(&mut self, text: &str) {
        self.update_chat_input(|chat_input| chat_input.mark_agent_message_submitted(text));
    }

    pub fn mark_shell_command_submitted(&mut self, command: &str) {
        self.update_chat_input(|chat_input| chat_input.mark_shell_command_submitted(command));
    }

    pub fn clear_composer_after_submit(&mut self) {
        self.update_chat_input(ChatInput::clear_after_submit);
    }

    pub fn move_composer_caret_to_point(
        &mut self,
        bounds: Rect,
        point: Point,
        mode: CodeEditorSelectionMode,
    ) -> bool {
        self.update_chat_input(|chat_input| chat_input.move_caret_to_point(bounds, point, mode))
    }

    pub fn move_composer_interaction_selection(&mut self, direction: SelectionDirection) {
        self.update_chat_input(|chat_input| chat_input.move_interaction_selection(direction));
    }

    pub fn activate_composer_interaction(&mut self) -> Option<ComposerInteractionActivation> {
        self.update_chat_input(ChatInput::activate_selected_interaction)
    }

    pub fn complete_selected_slash(&mut self) -> Option<String> {
        self.update_chat_input(ChatInput::complete_selected_slash)
    }

    pub fn dismiss_composer_interaction(&mut self) -> bool {
        self.update_chat_input(ChatInput::dismiss_interaction)
    }

    pub fn composer_interaction_view(&self) -> Option<ChatInputInteractionView<'_>> {
        self.chat_input().interaction().view()
    }

    pub fn composer_model_picker_visible(&self) -> bool {
        self.chat_input().interaction().is_model_picker_visible()
    }

    pub fn composer_interaction_visible(&self) -> bool {
        self.chat_input().interaction().is_visible()
    }

    pub fn select_composer_interaction_item(&mut self, index: usize) -> bool {
        self.update_chat_input(|chat_input| chat_input.select_interaction_item(index))
    }

    pub fn reset_composer_interaction_scroll(&mut self) {
        self.chat_widget.input_mut().reset_interaction_scroll();
    }

    pub fn scroll_composer_interaction(
        &mut self,
        command: ScrollCommand,
        viewport: Size,
        content: Size,
    ) -> bool {
        self.chat_widget
            .input_mut()
            .scroll_interaction(command, viewport, content)
    }

    pub fn replace_thread(
        &mut self,
        thread: Thread,
        transcript: ThreadTranscriptSnapshot,
        scroll_limit: usize,
    ) {
        let previous_line_count = line_count(self.chat_widget.transcript());
        if self.thread.as_ref().map(|current| &current.thread_id) != Some(&thread.thread_id) {
            self.update_chat_input(|input| input.set_history_thread(thread.thread_id.to_string()));
        }
        self.update_chat_input(|chat_input| synchronize_chat_input(chat_input, &thread));
        self.thread = Some(thread);
        self.chat_widget
            .transcript_mut()
            .replace_snapshot(transcript);
        self.preserve_timeline_after_growth(previous_line_count, scroll_limit);
    }

    pub fn apply_transcript_update(
        &mut self,
        update: ThreadTranscriptUpdateEnvelope,
        scroll_limit: usize,
    ) {
        let previous_line_count = line_count(self.chat_widget.transcript());
        self.chat_widget.transcript_mut().apply_update(update);
        self.preserve_timeline_after_growth(previous_line_count, scroll_limit);
    }

    pub fn timeline_scroll_limit(&self, bounds: Rect) -> usize {
        line_count(self.chat_widget.transcript()).saturating_sub(line_capacity(bounds))
    }

    pub fn set_working_directory(&mut self, working_directory: &Path) {
        self.update_chat_input(|chat_input| chat_input.set_working_directory(working_directory));
    }

    fn preserve_timeline_after_growth(&mut self, previous_line_count: usize, scroll_limit: usize) {
        let added_lines =
            line_count(self.chat_widget.transcript()).saturating_sub(previous_line_count);
        self.chat_widget
            .timeline_scroll_mut()
            .preserve_view_after_growth(added_lines, scroll_limit);
        self.chat_widget.timeline_scroll_mut().clamp(scroll_limit);
    }
}

fn synchronize_chat_input(chat_input: &mut ChatInput, thread: &Thread) {
    chat_input.replace_classification_history(classification_history_for_thread(thread));
    let Some(turn) = thread.turns.last() else {
        chat_input.synchronize_conversation(InputConversation::Standalone);
        return;
    };
    let has_agent_message = turn
        .items
        .iter()
        .any(|item| matches!(item, ThreadItem::AgentMessage { .. }));
    match (turn.status, has_agent_message) {
        (TurnStatus::Completed, true) => {
            chat_input.synchronize_conversation(InputConversation::AgentFollowUp);
        }
        (
            TurnStatus::Created
            | TurnStatus::Running
            | TurnStatus::WaitingForApproval
            | TurnStatus::WaitingForUserInput
            | TurnStatus::WaitingForCapability
            | TurnStatus::Cancelling,
            true,
        ) => chat_input.mark_agent_response_started(),
        _ => chat_input.synchronize_conversation(InputConversation::Standalone),
    }
}

fn classification_history_for_thread(thread: &Thread) -> Vec<InputHistoryEntry> {
    thread
        .turns
        .iter()
        .flat_map(|turn| {
            let agent_prompts = turn.items.iter().filter_map(|item| match item {
                ThreadItem::UserMessage { text, .. } => {
                    Some(InputHistoryEntry::agent(text.clone()))
                }
                _ => None,
            });
            let has_agent_prompt = turn
                .items
                .iter()
                .any(|item| matches!(item, ThreadItem::UserMessage { .. }));
            let shell_command = (!has_agent_prompt && !turn_command_was_not_found(&turn.items))
                .then(|| turn.items.iter().find_map(shell_history_entry))
                .flatten();
            agent_prompts.chain(shell_command)
        })
        .collect()
}

fn shell_history_entry(item: &ThreadItem) -> Option<InputHistoryEntry> {
    let ThreadItem::ToolCall {
        name,
        arguments_json,
        ..
    } = item
    else {
        return None;
    };
    if name.as_str() != "shell-command" {
        return None;
    }
    let Value::Object(arguments) = serde_json::from_str(arguments_json).ok()? else {
        return None;
    };
    if let Some(command) = arguments.get("command").and_then(Value::as_str) {
        return Some(InputHistoryEntry::shell(command));
    }
    let arguments = arguments.get("arguments").and_then(Value::as_array)?;
    (arguments.len() == 2 && arguments[0].as_str() == Some("-lc"))
        .then(|| arguments[1].as_str().map(InputHistoryEntry::shell))
        .flatten()
}

fn turn_command_was_not_found(items: &[ThreadItem]) -> bool {
    items.iter().any(|item| {
        let ThreadItem::ToolResult { text, .. } = item else {
            return false;
        };
        serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| value.get("exit_code").and_then(Value::as_i64))
            == Some(127)
    })
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
