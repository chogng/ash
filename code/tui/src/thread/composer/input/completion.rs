//! Slash, mention, and Skill completion owned by `ChatInput`.

mod mention;
mod skill;
mod view;

use super::slash_commands::built_in_slash_command_definitions;
use super::state::ChatInput;
use super::state::ChatInputOutcome;
use ash_file_search::PathSearchSnapshot;
use ash_protocol::SkillRef;
use ash_slash_commands::SlashCommandCatalog;
use ash_slash_commands::SlashCommandDefinition;
use ash_slash_commands::SlashCommandInput;
use ash_slash_commands::SlashCommandInvocation;
use ash_slash_commands::SlashCommandsState;
use ash_slash_commands::SlashCommandsView;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
pub(crate) use mention::MentionPluginItem;
pub(crate) use mention::MentionPopupView;
use mention::Mentions;
pub(crate) use skill::SkillCompletionItem;
use skill::SkillCompletionState;
pub(crate) use skill::SkillCompletionView;
use std::ops::Range;
pub(crate) use view::contains;
pub(crate) use view::draw;
pub(crate) use view::index_at;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChatInputCatalog {
    slash_commands: SlashCommandCatalog,
    skills: Vec<SkillCompletionItem>,
    plugins: Vec<MentionPluginItem>,
}

impl ChatInputCatalog {
    pub(crate) fn new(
        slash_commands: SlashCommandCatalog,
        skills: Vec<SkillCompletionItem>,
        plugins: Vec<MentionPluginItem>,
    ) -> Self {
        Self {
            slash_commands,
            skills,
            plugins,
        }
    }

    pub(crate) fn with_slash_commands(slash_commands: SlashCommandCatalog) -> Self {
        Self::new(slash_commands, Vec::new(), Vec::new())
    }

    pub(crate) fn slash_commands(&self) -> &SlashCommandCatalog {
        &self.slash_commands
    }

    #[cfg(test)]
    pub(crate) fn skills(&self) -> &[SkillCompletionItem] {
        &self.skills
    }

    #[cfg(test)]
    pub(crate) fn plugins(&self) -> &[MentionPluginItem] {
        &self.plugins
    }
}

impl Default for ChatInputCatalog {
    fn default() -> Self {
        let slash_commands = SlashCommandCatalog::with_local_and_server(
            built_in_slash_command_definitions(),
            std::iter::empty(),
        )
        .expect("the TUI built-in Slash Commands catalog is valid");
        Self::with_slash_commands(slash_commands)
    }
}

#[derive(Debug)]
pub(super) struct CompletionState {
    slash_commands: SlashCommandsState,
    mentions: Mentions,
    skills: SkillCompletionState,
}

#[derive(Debug)]
pub(super) enum CompletionInputOutcome {
    Completed(CompletionEdit),
    Consumed,
    Submit(CompletionEdit),
    Unhandled,
}

#[derive(Debug)]
pub(super) enum CompletionEdit {
    Text {
        range: Range<usize>,
        replacement: String,
    },
    Element {
        range: Range<usize>,
        value: String,
        skill: Option<SkillRef>,
    },
}

pub(crate) enum CompletionView<'a> {
    Slash(SlashCommandsView<'a>),
    Mention(MentionPopupView<'a>),
    Skill(SkillCompletionView<'a>),
}

impl CompletionState {
    pub(super) fn new(catalog: ChatInputCatalog) -> Self {
        Self {
            slash_commands: SlashCommandsState::new(catalog.slash_commands),
            mentions: Mentions::default(),
            skills: SkillCompletionState::default(),
        }
        .with_catalog_entries(catalog.skills, catalog.plugins)
    }

    pub(super) fn handle_key(&mut self, key: KeyEvent) -> CompletionInputOutcome {
        if self.skills.view().is_some() {
            return match key.code {
                KeyCode::Esc => {
                    self.skills.dismiss();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Up => {
                    self.skills.select_previous();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Down => {
                    self.skills.select_next();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Tab => self
                    .skills
                    .complete_selected()
                    .map(skill_edit)
                    .map(CompletionInputOutcome::Completed)
                    .unwrap_or(CompletionInputOutcome::Consumed),
                KeyCode::Enter if key.modifiers.is_empty() => self
                    .skills
                    .complete_selected()
                    .map(skill_edit)
                    .map(CompletionInputOutcome::Completed)
                    .unwrap_or(CompletionInputOutcome::Unhandled),
                _ => CompletionInputOutcome::Unhandled,
            };
        }

        if self.mentions.view().is_some() {
            return match key.code {
                KeyCode::Esc => {
                    self.mentions.dismiss();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Up => {
                    self.mentions.select_previous();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Down => {
                    self.mentions.select_next();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Tab => self
                    .mentions
                    .complete_selected()
                    .map(mention_edit)
                    .map(CompletionInputOutcome::Completed)
                    .unwrap_or(CompletionInputOutcome::Consumed),
                KeyCode::Enter if key.modifiers.is_empty() => self
                    .mentions
                    .complete_selected()
                    .map(mention_edit)
                    .map(CompletionInputOutcome::Completed)
                    .unwrap_or(CompletionInputOutcome::Unhandled),
                _ => CompletionInputOutcome::Unhandled,
            };
        }

        if self.slash_commands.view().is_some() {
            return match key.code {
                KeyCode::Esc => {
                    self.slash_commands.dismiss();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Up => {
                    self.slash_commands.select_previous();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Down => {
                    self.slash_commands.select_next();
                    CompletionInputOutcome::Consumed
                }
                KeyCode::Tab => self
                    .slash_commands
                    .selected_command()
                    .and_then(|command| self.slash_edit(command))
                    .map(CompletionInputOutcome::Completed)
                    .unwrap_or(CompletionInputOutcome::Consumed),
                KeyCode::Enter if key.modifiers.is_empty() => self
                    .slash_commands
                    .selected_command()
                    .and_then(|command| self.slash_edit(command))
                    .map(CompletionInputOutcome::Submit)
                    .unwrap_or(CompletionInputOutcome::Unhandled),
                _ => CompletionInputOutcome::Unhandled,
            };
        }

        CompletionInputOutcome::Unhandled
    }

    pub(super) fn sync_textarea(
        &mut self,
        text: &str,
        cursor: usize,
        slash_command_element_active: bool,
    ) {
        self.mentions.sync(text, cursor);
        self.skills.sync(text, cursor);
        if slash_command_element_active {
            self.slash_commands.clear();
        } else {
            self.slash_commands.sync_input(text, cursor);
        }
    }

    pub(super) fn view(&self) -> Option<CompletionView<'_>> {
        self.slash_commands
            .view()
            .map(CompletionView::Slash)
            .or_else(|| self.mentions.view().map(CompletionView::Mention))
            .or_else(|| self.skills.view().map(CompletionView::Skill))
    }

    pub(super) fn mention_query(&self) -> Option<&str> {
        self.mentions.query()
    }

    pub(super) fn apply_file_search_snapshot(&mut self, snapshot: PathSearchSnapshot) {
        self.mentions.apply_search_snapshot(snapshot);
    }

    pub(super) fn replace_catalog(&mut self, catalog: ChatInputCatalog) {
        self.slash_commands.set_catalog(catalog.slash_commands);
        self.skills.replace_catalog(catalog.skills);
        self.mentions.replace_plugin_catalog(catalog.plugins);
    }

    pub(super) fn activate(&mut self, index: usize) -> Option<CompletionInputOutcome> {
        match self.view()? {
            CompletionView::Slash(_) => {
                let command = self.slash_commands.command_at(index)?.clone();
                self.slash_edit(&command)
                    .map(CompletionInputOutcome::Submit)
            }
            CompletionView::Mention(_) => self
                .mentions
                .complete_at(index)
                .map(mention_edit)
                .map(CompletionInputOutcome::Completed),
            CompletionView::Skill(_) => self
                .skills
                .complete_at(index)
                .map(skill_edit)
                .map(CompletionInputOutcome::Completed),
        }
    }

    pub(super) fn invocation(&self, text: &str) -> Option<SlashCommandInvocation> {
        self.slash_commands.invocation(text)
    }

    pub(super) fn command_element_range(&self, text: &str, cursor: usize) -> Option<Range<usize>> {
        self.slash_commands.command_element_range(text, cursor)
    }

    pub(super) fn argument_hint(&self, text: &str, cursor: usize) -> Option<&str> {
        SlashCommandInput::at_cursor(text, cursor, self.slash_commands.catalog()).argument_hint()
    }

    pub(super) fn clear(&mut self) {
        self.slash_commands.clear();
        self.mentions.clear();
        self.skills.clear();
    }

    fn slash_edit(&self, command: &SlashCommandDefinition) -> Option<CompletionEdit> {
        let completion = self.slash_commands.completion(command)?;
        Some(CompletionEdit::Text {
            range: completion.range,
            replacement: completion.replacement,
        })
    }

    fn with_catalog_entries(
        mut self,
        skills: Vec<SkillCompletionItem>,
        plugins: Vec<MentionPluginItem>,
    ) -> Self {
        self.skills.replace_catalog(skills);
        self.mentions.replace_plugin_catalog(plugins);
        self
    }
}

fn mention_edit(completion: mention::MentionCompletion) -> CompletionEdit {
    CompletionEdit::Element {
        range: completion.range,
        value: completion.value,
        skill: None,
    }
}

fn skill_edit(completion: skill::SkillCompletion) -> CompletionEdit {
    CompletionEdit::Element {
        range: completion.range,
        value: completion.value,
        skill: Some(completion.skill),
    }
}

impl ChatInput {
    pub(crate) fn completion(&self) -> Option<CompletionView<'_>> {
        self.completion.view()
    }

    pub(crate) fn mention_query(&self) -> Option<&str> {
        self.completion.mention_query()
    }

    pub(crate) fn replace_catalog(&mut self, catalog: ChatInputCatalog) {
        self.completion.replace_catalog(catalog);
        self.sync_completion();
    }

    pub(crate) fn apply_file_search_snapshot(&mut self, snapshot: PathSearchSnapshot) {
        self.completion.apply_file_search_snapshot(snapshot);
    }

    pub(crate) fn activate_completion(&mut self, index: usize) -> Option<ChatInputOutcome> {
        let outcome = self.completion.activate(index)?;
        self.apply_completion_outcome(outcome)
    }

    pub(super) fn handle_completion_key(&mut self, key: KeyEvent) -> Option<ChatInputOutcome> {
        let outcome = self.completion.handle_key(key);
        self.apply_completion_outcome(outcome)
    }

    pub(super) fn sync_completion(&mut self) {
        let desired_command = self
            .completion
            .command_element_range(self.textarea.text(), self.textarea.cursor());
        self.reconcile_completion_bindings(desired_command);
        self.completion.sync_textarea(
            self.textarea.text(),
            self.textarea.cursor(),
            self.slash_command_element.is_some(),
        );
    }

    pub(super) fn current_command(&self) -> Option<SlashCommandInvocation> {
        self.submission_display_text()
            .and_then(|text| self.completion.invocation(&text))
    }

    fn apply_completion_outcome(
        &mut self,
        outcome: CompletionInputOutcome,
    ) -> Option<ChatInputOutcome> {
        match outcome {
            CompletionInputOutcome::Completed(edit) => {
                self.apply_completion_edit(edit);
                Some(ChatInputOutcome::Consumed)
            }
            CompletionInputOutcome::Consumed => Some(ChatInputOutcome::Consumed),
            CompletionInputOutcome::Submit(edit) => {
                self.apply_completion_edit(edit);
                Some(self.submit_current())
            }
            CompletionInputOutcome::Unhandled => None,
        }
    }

    fn apply_completion_edit(&mut self, edit: CompletionEdit) {
        self.reset_history_navigation();
        match edit {
            CompletionEdit::Text { range, replacement } => {
                self.textarea.replace_range(range, &replacement);
            }
            CompletionEdit::Element {
                range,
                value,
                skill,
            } => {
                self.textarea.replace_range(range, "");
                let element_id = self.textarea.insert_element(&value);
                if let Some(skill) = skill {
                    self.skill_bindings.push((element_id, skill));
                }
                if !self.textarea.text()[self.textarea.cursor()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
                {
                    self.textarea.insert_text(" ");
                }
            }
        }
        self.sync_completion();
    }

    fn reconcile_completion_bindings(&mut self, desired_command: Option<Range<usize>>) {
        self.pending_pastes.retain_present_in(&self.textarea);
        self.attachments.reconcile(&mut self.textarea);
        self.skill_bindings
            .retain(|(element_id, _)| self.textarea.has_element(*element_id));
        if let Some(element_id) = self.slash_command_element {
            let current = self.textarea.element_range(element_id);
            if current.is_none() || current != desired_command {
                self.textarea.unmark_element(element_id);
                self.slash_command_element = None;
            }
        }
        if self.slash_command_element.is_none()
            && let Some(range) = desired_command
        {
            self.slash_command_element = Some(self.textarea.mark_element(range));
        }
    }
}
