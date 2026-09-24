mod catalog;
mod classification;
mod editor;
mod interaction;
mod interaction_view;
mod key_hint_bar;
mod layout;
mod shell_completion;
mod toolbar;
mod view;

use std::path::Path;
use std::path::PathBuf;

use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorLanguage;
use ash_editor::CodeEditorSelectionMode;
use ash_editor::CodeEditorStyle;
use ash_input_classifier::InputClassifier;
use ash_input_classifier::InputConversation;
use ash_input_classifier::InputHistoryEntry;
use ash_input_classifier::ShellCompletionSnapshot;
use ash_slash_commands::SlashCommandCatalogError;
use ash_slash_commands::SlashCommandDefinition;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
pub use catalog::composer_model_options;
use classification::ClassificationState;
pub use classification::ComposerClassificationResult;
pub use classification::ComposerClassificationTask;
pub use classification::ComposerClassificationUpdate;
use editor::ChatInputEditor;
pub use interaction::ChatInputInteractionItem;
use interaction::ChatInputInteractionState;
pub use interaction::ChatInputInteractionView;
pub use interaction::ComposerInteractionActivation;
pub use interaction::ComposerModelOption;
pub use interaction::SelectionDirection;
pub use layout::ComposerPanelLayout;
pub use layout::INTERACTION_ROW_HEIGHT;
pub use layout::interaction_content_size;
pub use layout::interaction_list_bounds;
pub use layout::interaction_preferred_height;
pub use layout::interaction_selection_scroll_command;
use message_history::MessageHistory;
use message_history::MessageHistoryKind as InputKind;
use message_history::MessageHistoryRecall as HistoryRecall;
use message_history::MessageHistoryRecallEffect as RecallEffect;
use shell_completion::ShellGhostSuggestion;
use shell_completion::shell_ghost_suggestion;
pub(crate) use view::ChatInputView;
pub(crate) use view::draw_chat_input;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInputCompositionEvent;

/// Current classifier-selected submission route for the Session ChatInput.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ComposerRoute {
    #[default]
    Agent,
    Shell,
}

pub enum ComposerSubmission {
    AgentMessage(String),
    ShellCommand(String),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum AgentResponseState {
    #[default]
    None,
    Pending,
}

/// Input, routing, history, and completion state owned by one Session Pane.
pub struct ChatInput {
    input: ChatInputEditor,
    interaction: ChatInputInteractionState,
    interaction_scroll: ScrollState,
    route: ComposerRoute,
    classifier: InputClassifier,
    classification: ClassificationState,
    conversation: InputConversation,
    agent_response: AgentResponseState,
    history: HistoryRecall,
    history_draft: Option<HistoryDraft>,
    history_composition: Option<String>,
    recalled_route: Option<ComposerRoute>,
    shell_suggestion: Option<ShellGhostSuggestion>,
    dismissed_shell_suggestion_input: Option<String>,
}

struct HistoryDraft {
    input: ChatInputEditor,
    route: ComposerRoute,
    needs_classification: bool,
}

impl Default for ChatInput {
    fn default() -> Self {
        Self::for_working_directory(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

impl ChatInput {
    pub fn for_working_directory(working_directory: impl Into<PathBuf>) -> Self {
        ash_input_classifier::start_background_warmup();
        Self {
            input: ChatInputEditor::default(),
            interaction: ChatInputInteractionState::new(),
            interaction_scroll: ScrollState::default(),
            route: ComposerRoute::Agent,
            classifier: InputClassifier::for_working_directory(working_directory),
            classification: ClassificationState::default(),
            conversation: InputConversation::Standalone,
            agent_response: AgentResponseState::None,
            history: HistoryRecall::default(),
            history_draft: None,
            history_composition: None,
            recalled_route: None,
            shell_suggestion: None,
            dismissed_shell_suggestion_input: None,
        }
    }

    pub const fn input(&self) -> &ChatInputEditor {
        &self.input
    }

    pub const fn interaction(&self) -> &ChatInputInteractionState {
        &self.interaction
    }

    pub(crate) const fn interaction_scroll(&self) -> ScrollState {
        self.interaction_scroll
    }

    pub fn set_interaction_catalog(
        &mut self,
        slash_commands: Vec<SlashCommandDefinition>,
        models: Vec<ComposerModelOption>,
    ) -> Result<(), SlashCommandCatalogError> {
        self.update_interaction(|interaction| interaction.set_catalog(slash_commands, models))
    }

    pub fn move_interaction_selection(&mut self, direction: SelectionDirection) {
        self.update_interaction(|interaction| interaction.move_selection(direction));
    }

    pub fn activate_selected_interaction(&mut self) -> Option<ComposerInteractionActivation> {
        self.update_interaction(ChatInputInteractionState::activate_selected)
    }

    pub fn complete_selected_slash(&mut self) -> Option<String> {
        self.update_interaction(ChatInputInteractionState::complete_selected_slash)
    }

    pub fn dismiss_interaction(&mut self) -> bool {
        let text = self.input.text().to_owned();
        self.update_interaction(|interaction| interaction.dismiss(&text))
    }

    pub fn select_interaction_item(&mut self, index: usize) -> bool {
        self.update_interaction(|interaction| interaction.select_item(index))
    }

    pub fn reset_interaction_scroll(&mut self) {
        self.interaction_scroll = ScrollState::default();
    }

    pub fn scroll_interaction(
        &mut self,
        command: ScrollCommand,
        viewport: Size,
        content: Size,
    ) -> bool {
        self.interaction_scroll.apply(
            command,
            ScrollMetrics::new(viewport, content),
            ScrollAxis::Vertical,
        )
    }

    pub const fn route(&self) -> ComposerRoute {
        self.route
    }

    pub fn submission(&self) -> Option<ComposerSubmission> {
        if self.classification.is_pending() || self.input.has_active_composition() {
            return None;
        }
        (!self.input.text().trim().is_empty()).then(|| match self.route {
            ComposerRoute::Agent => ComposerSubmission::AgentMessage(self.input.text().to_owned()),
            ComposerRoute::Shell => ComposerSubmission::ShellCommand(self.input.text().to_owned()),
        })
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.leave_history();
        self.input.set_text(text);
        self.refresh_classification();
    }

    pub fn set_working_directory(&mut self, working_directory: &Path) {
        self.classifier.set_working_directory(working_directory);
        self.reclassify();
    }

    pub fn refresh_dir_catalog(&mut self) {
        self.classifier.refresh_dir_catalog();
        self.reclassify();
    }

    pub fn has_shell_suggestion(&self) -> bool {
        self.shell_suggestion.is_some()
    }

    pub fn accept_shell_suggestion(&mut self) -> bool {
        let Some(suggestion) = self.shell_suggestion.take() else {
            return false;
        };
        self.leave_history();
        self.dismissed_shell_suggestion_input = None;
        let applied = self.input.apply_text_edit(suggestion.edit);
        self.refresh_classification();
        applied
    }

    pub fn dismiss_shell_suggestion(&mut self) -> bool {
        if self.shell_suggestion.take().is_none() {
            return false;
        }
        self.dismissed_shell_suggestion_input = Some(self.input.text().to_owned());
        self.input.hide_ghost_text();
        true
    }

    fn shell_completion_snapshot(&self) -> Option<ShellCompletionSnapshot> {
        let text = self.input.text();
        let cursor = self.input.cursor();
        if cursor != text.len()
            || text.trim().is_empty()
            || text.trim_start().starts_with('/')
            || self.input.selected_text().is_some()
            || self.input.has_active_composition()
            || (self.route == ComposerRoute::Agent
                && text[..cursor]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace))
        {
            return None;
        }
        Some(self.classifier.shell_completion_snapshot(text, cursor))
    }

    pub fn mark_agent_message_submitted(&mut self, text: &str) {
        self.classifier
            .record_submission(InputHistoryEntry::agent(text));
        self.conversation = InputConversation::Standalone;
        self.agent_response = AgentResponseState::Pending;
        self.reclassify();
    }

    pub fn mark_shell_command_submitted(&mut self, command: &str) {
        self.classifier
            .record_submission(InputHistoryEntry::shell(command));
        self.conversation = InputConversation::Standalone;
        self.agent_response = AgentResponseState::None;
        self.reclassify();
    }

    pub fn replace_classification_history(
        &mut self,
        entries: impl IntoIterator<Item = InputHistoryEntry>,
    ) {
        if self.classifier.replace_history(entries) {
            self.reclassify();
        }
    }

    pub fn mark_agent_response_started(&mut self) {
        let changed = self.conversation != InputConversation::Standalone;
        self.conversation = InputConversation::Standalone;
        self.agent_response = AgentResponseState::Pending;
        if changed {
            self.reclassify();
        }
    }

    #[cfg(test)]
    pub fn mark_agent_turn_completed(&mut self) {
        if self.agent_response == AgentResponseState::Pending {
            self.conversation = InputConversation::AgentFollowUp;
            self.agent_response = AgentResponseState::None;
            self.reclassify();
        }
    }

    pub fn synchronize_conversation(&mut self, conversation: InputConversation) {
        let changed = self.conversation != conversation;
        self.conversation = conversation;
        self.agent_response = AgentResponseState::None;
        if changed {
            self.reclassify();
        }
    }

    pub fn set_input_style(&mut self, style: CodeEditorStyle) {
        self.input.set_style(style);
    }

    pub fn apply(&mut self, command: CodeEditorCommand) {
        if let Some(query) = self.history.query() {
            let mut query = query.to_owned();
            let effect = match command {
                CodeEditorCommand::Insert(text) => {
                    query.push_str(&text);
                    self.history.search(query)
                }
                CodeEditorCommand::Backspace => {
                    query.pop();
                    self.history.search(query)
                }
                CodeEditorCommand::MoveUp(_) => self.history.older(),
                CodeEditorCommand::MoveDown(_) => self.history.newer(),
                _ => RecallEffect::Keep,
            };
            self.apply_history_effect(effect);
            return;
        }
        let effect = match command {
            CodeEditorCommand::MoveUp(CodeEditorSelectionMode::Move)
                if self.input.is_collapsed_at_first_row() =>
            {
                Some(self.history.older())
            }
            CodeEditorCommand::MoveDown(CodeEditorSelectionMode::Move)
                if self.input.is_collapsed_at_last_row() =>
            {
                Some(self.history.newer())
            }
            _ => None,
        };
        if let Some(effect) = effect {
            self.classification.cancel_submission();
            self.apply_history_effect(effect);
            return;
        }
        self.leave_history();
        self.input.apply(command);
        self.refresh_classification();
    }

    pub fn apply_composition(&mut self, event: TextInputCompositionEvent) {
        self.classification.cancel_submission();
        if let Some(query) = self.history.query() {
            match event {
                TextInputCompositionEvent::Preedit { text, .. } => {
                    self.history_composition = Some(text)
                }
                TextInputCompositionEvent::Commit(text) => {
                    let effect = self.history.search(format!("{query}{text}"));
                    self.history_composition = None;
                    self.apply_history_effect(effect);
                }
                TextInputCompositionEvent::Cancel => self.history_composition = None,
            }
            return;
        }
        self.leave_history();
        self.input.apply_composition(event);
        self.refresh_classification();
    }

    pub fn cancel_composition(&mut self) {
        self.classification.cancel_submission();
        self.history_composition = None;
        self.input.cancel_composition();
        self.refresh_shell_suggestion();
    }

    pub fn clear_after_submit(&mut self) {
        if !self.input.text().trim().is_empty() {
            let kind = match self.route {
                ComposerRoute::Agent if self.input.text().trim_start().starts_with('/') => {
                    InputKind::Command
                }
                ComposerRoute::Agent => InputKind::Agent,
                ComposerRoute::Shell => InputKind::Shell,
            };
            self.history.record(self.input.text().to_owned(), kind);
        }
        self.input.clear();
        self.classification.reset("");
        self.route = ComposerRoute::Agent;
        self.refresh_editor_language();
        self.leave_history();
        self.dismissed_shell_suggestion_input = None;
        self.refresh_shell_suggestion();
        self.refresh_interaction();
    }

    pub fn move_caret_to_point(
        &mut self,
        bounds: Rect,
        point: Point,
        mode: CodeEditorSelectionMode,
    ) -> bool {
        self.leave_history();
        let moved = self.input.move_caret_to_point(bounds, point, mode);
        if moved {
            self.refresh_shell_suggestion();
        }
        moved
    }

    pub fn connect_history(&mut self, client: MessageHistory) {
        self.history.connect(client);
    }

    pub fn set_history_thread(&mut self, thread_id: String) {
        self.cancel_history();
        self.history.set_thread_id(thread_id);
    }

    pub fn history_unavailable(&mut self, error: String) {
        self.history.unavailable(error);
    }

    pub fn poll_history(&mut self) -> bool {
        let (changed, effect) = self.history.poll();
        self.apply_history_effect(effect);
        changed
    }

    pub fn searching_history(&self) -> bool {
        self.history.query().is_some()
    }

    pub fn start_history_search(&mut self) {
        self.classification.cancel_submission();
        let effect = if self.searching_history() {
            self.history.older()
        } else {
            self.history.search(self.input.text().to_owned())
        };
        self.apply_history_effect(effect);
        self.refresh_interaction();
    }

    pub fn accept_history(&mut self) {
        if self.history_composition.is_some() {
            return;
        }
        let effect = self.history.accept();
        self.apply_history_effect(effect);
        self.history_draft = None;
        self.refresh_interaction();
    }

    pub fn cancel_history(&mut self) {
        self.history_composition = None;
        self.history.reset();
        self.apply_history_effect(RecallEffect::Restore);
        self.reclassify();
    }

    pub fn history_status(&self) -> Option<String> {
        let status = self.history.status();
        if let Some(error) = status.error {
            return Some(format!("History: {error}"));
        }
        if !status.active {
            return None;
        }
        let state = if status.loading {
            "Searching…"
        } else if status.empty {
            "No match"
        } else {
            "↑/↓ browse"
        };
        Some(match status.query {
            Some(query) => {
                let preedit = self.history_composition.as_deref().unwrap_or("");
                format!("History search: {query}{preedit} · {state} · Enter edit · Esc cancel")
            }
            None => format!("History · {state} · Esc restore draft"),
        })
    }

    fn apply_history_effect(&mut self, effect: RecallEffect) {
        match effect {
            RecallEffect::Keep => {}
            RecallEffect::Restore => {
                if let Some(draft) = self.history_draft.take() {
                    self.input = draft.input;
                    self.route = draft.route;
                    self.recalled_route = (!draft.needs_classification).then_some(draft.route);
                    self.reclassify();
                }
            }
            RecallEffect::Recall(submission) => {
                if self.history_draft.is_none() {
                    self.history_draft = Some(HistoryDraft {
                        input: self.input.take_draft(),
                        route: self.route,
                        needs_classification: self.classification.is_pending(),
                    });
                }
                self.input.set_text(submission.text);
                self.classification.reset(self.input.text());
                self.route = match submission.kind {
                    InputKind::Shell => ComposerRoute::Shell,
                    InputKind::Agent | InputKind::Command => ComposerRoute::Agent,
                };
                self.recalled_route = Some(self.route);
                self.refresh_editor_language();
                self.input.hide_ghost_text();
                self.shell_suggestion = None;
                self.refresh_interaction();
            }
        }
    }

    fn refresh_editor_language(&mut self) {
        self.input.set_language(match self.route {
            ComposerRoute::Agent => CodeEditorLanguage::PlainText,
            ComposerRoute::Shell => CodeEditorLanguage::Shell,
        });
    }

    fn refresh_shell_suggestion(&mut self) {
        let text = self.input.text().to_owned();
        if self.dismissed_shell_suggestion_input.as_deref() == Some(&text) {
            self.shell_suggestion = None;
            self.input.hide_ghost_text();
            return;
        }
        self.dismissed_shell_suggestion_input = None;
        let suggestion = self
            .shell_completion_snapshot()
            .filter(|snapshot| !snapshot.has_exact_match())
            .and_then(|snapshot| {
                shell_ghost_suggestion(&text, self.input.cursor(), snapshot.into_completions())
            });
        if let Some(suggestion) = &suggestion {
            let typed = &text[suggestion.edit.range.clone()];
            let ghost_text = suggestion.edit.new_text[typed.len()..].to_owned();
            self.input.show_ghost_text(ghost_text);
        } else {
            self.input.hide_ghost_text();
        }
        self.shell_suggestion = suggestion;
    }

    fn refresh_interaction(&mut self) {
        let text = if self.history.active() {
            String::new()
        } else {
            self.input.text().to_owned()
        };
        let route = self.route;
        self.update_interaction(|interaction| interaction.sync_input(&text, route));
    }

    fn update_interaction<R>(
        &mut self,
        update: impl FnOnce(&mut ChatInputInteractionState) -> R,
    ) -> R {
        let previous_surface = self.interaction.surface();
        let result = update(&mut self.interaction);
        if previous_surface != self.interaction.surface() {
            self.reset_interaction_scroll();
        }
        result
    }

    fn leave_history(&mut self) {
        self.recalled_route = None;
        self.history_composition = None;
        self.history.reset();
        self.history_draft = None;
    }
}

#[cfg(test)]
#[path = "chat_input/chat_input_tests.rs"]
mod tests;
