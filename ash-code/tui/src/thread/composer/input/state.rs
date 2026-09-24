use super::attachments::Attachments;
use super::attachments::ImagePasteOutcome;
use super::completion::ChatInputCatalog;
use super::completion::CompletionState;
use super::editor::TextArea;
use super::editor::TextAreaOutcome;
use super::editor::TextElementId;
use super::pending_pastes::PendingPastes;
use super::slash_commands::SlashCommandInvocation;
use super::slash_commands::into_command_invocation;
use super::vim::ChatInputMode;
use super::vim::VimOutcome;
use super::vim::VimState;
use super::wrap::wrap_input;
use ash_protocol::SkillRef;
use ash_slash_commands::SlashCommandOrigin;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use message_history::MessageHistory;
use message_history::MessageHistoryKind as InputKind;
use message_history::MessageHistoryRecall as HistoryRecall;
use message_history::MessageHistoryRecallEffect as RecallEffect;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputOutcome {
    Command(SlashCommandInvocation),
    Consumed,
    Submit(ChatSubmission),
    Unhandled,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ChatInputQueueOutcome {
    Command(SlashCommandInvocation),
    Consumed,
    Queued(QueuedChatInput),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChatInputItem {
    Text(String),
    Image { url: String },
    Attachment(ash_protocol::ImageAttachmentRef),
    Audio { url: String },
    AudioAttachment(ash_protocol::AudioAttachmentRef),
    Context { name: String, content: String },
    Skill { skill: SkillRef },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChatSubmission {
    pub(crate) display_text: String,
    pub(crate) input: Vec<ChatInputItem>,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct QueuedChatInput {
    submission: ChatSubmission,
    draft: ChatInputDraft,
}

impl QueuedChatInput {
    pub(crate) fn from_submission(submission: ChatSubmission) -> Self {
        let mut input = ChatInput::with_catalog(ChatInputCatalog::default());
        let mut skills = submission
            .input
            .iter()
            .filter_map(|item| match item {
                ChatInputItem::Skill { skill } => Some(skill.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        for item in &submission.input {
            match item {
                ChatInputItem::Text(text) => {
                    let mut remaining = text.as_str();
                    loop {
                        let next = skills
                            .iter()
                            .enumerate()
                            .filter_map(|(index, skill)| {
                                let selector = format!("${}", skill.id.name);
                                remaining
                                    .match_indices(&selector)
                                    .find(|(offset, _)| {
                                        let before = &remaining[..*offset];
                                        let after = &remaining[*offset + selector.len()..];
                                        (before.is_empty() || before.ends_with(char::is_whitespace))
                                            && after.chars().next().is_none_or(|ch| {
                                                !ch.is_alphanumeric()
                                                    && !matches!(ch, '_' | '-' | '.')
                                            })
                                    })
                                    .map(|(offset, _)| (offset, index, selector))
                            })
                            .min_by_key(|(offset, _, _)| *offset);
                        let Some((offset, index, selector)) = next else {
                            input
                                .pending_pastes
                                .insert_text(&mut input.textarea, remaining.to_owned());
                            break;
                        };
                        input
                            .pending_pastes
                            .insert_text(&mut input.textarea, remaining[..offset].to_owned());
                        let element = input.textarea.insert_element(&selector);
                        input.skill_bindings.push((element, skills.remove(index)));
                        remaining = &remaining[offset + selector.len()..];
                    }
                }
                ChatInputItem::Image { .. }
                | ChatInputItem::Attachment(_)
                | ChatInputItem::Audio { .. }
                | ChatInputItem::AudioAttachment(_) => input
                    .attachments
                    .insert_item(&mut input.textarea, item.clone()),
                ChatInputItem::Context { name, content } => {
                    let element = input.textarea.insert_element(&format!("[Context: {name}]"));
                    input
                        .contexts
                        .push((element, name.clone(), content.clone()));
                }
                ChatInputItem::Skill { .. } => {}
            }
        }
        for skill in skills {
            input.textarea.insert_text(" ");
            let element = input
                .textarea
                .insert_element(&format!("${}", skill.id.name));
            input.skill_bindings.push((element, skill));
        }
        Self {
            submission,
            draft: input.take_draft(),
        }
    }

    pub(crate) fn display_text(&self) -> &str {
        &self.submission.display_text
    }

    pub(crate) fn submission(&self) -> &ChatSubmission {
        &self.submission
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChatInputDraft {
    textarea: TextArea,
    vim: VimState,
    slash_command_element: Option<TextElementId>,
    skill_bindings: Vec<(TextElementId, SkillRef)>,
    contexts: Vec<(TextElementId, String, String)>,
    pending_pastes: PendingPastes,
    attachments: Attachments,
}

/// Owns the editable draft, Slash/Mention/Skill completion, and typed submission assembly.
#[derive(Debug)]
pub(crate) struct ChatInput {
    generation: u64,
    pub(super) textarea: TextArea,
    pub(super) completion: CompletionState,
    input_mode: ChatInputMode,
    vim: VimState,
    pub(super) slash_command_element: Option<TextElementId>,
    pub(super) skill_bindings: Vec<(TextElementId, SkillRef)>,
    contexts: Vec<(TextElementId, String, String)>,
    pub(super) pending_pastes: PendingPastes,
    pub(super) attachments: Attachments,
    history: HistoryRecall,
    history_draft: Option<ChatInputDraft>,
}

impl ChatInput {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_catalog(ChatInputCatalog::default())
    }

    pub(crate) fn with_catalog(catalog: ChatInputCatalog) -> Self {
        Self {
            generation: 0,
            textarea: TextArea::new(),
            completion: CompletionState::new(catalog),
            input_mode: ChatInputMode::Standard,
            vim: VimState::default(),
            slash_command_element: None,
            skill_bindings: Vec::new(),
            contexts: Vec::new(),
            pending_pastes: PendingPastes::default(),
            attachments: Attachments::default(),
            history: HistoryRecall::default(),
            history_draft: None,
        }
    }

    pub(in crate::thread::composer) fn handle_key(&mut self, key: KeyEvent) -> ChatInputOutcome {
        if self.history.query().is_some() {
            return self.handle_history_search_key(key);
        }
        if key.code == KeyCode::Char('r') && key.modifiers == KeyModifiers::CONTROL {
            let effect = self.history.search(self.textarea.text().to_owned());
            self.apply_history_effect(effect);
            self.completion.clear();
            return ChatInputOutcome::Consumed;
        }
        if key.code == KeyCode::Esc && self.history.active() {
            self.history.reset();
            self.apply_history_effect(RecallEffect::Restore);
            return ChatInputOutcome::Consumed;
        }
        if let Some(outcome) = self.handle_completion_key(key) {
            return outcome;
        }
        if self.input_mode == ChatInputMode::Vim
            && self.vim.handle_key(&mut self.textarea, key) == VimOutcome::Consumed
        {
            self.reset_history_navigation();
            self.sync_completion();
            return ChatInputOutcome::Consumed;
        }
        if key.code == KeyCode::Enter && key.modifiers.is_empty() && self.accepts_submission_key() {
            return self.submit_current();
        }
        if is_newline_key(key) && self.accepts_submission_key() {
            self.reset_history_navigation();
            self.textarea.insert_newline();
            self.sync_completion();
            return ChatInputOutcome::Consumed;
        }
        match key.code {
            KeyCode::Up if !self.textarea.can_move_up() => {
                let effect = self.history.older();
                self.apply_history_effect(effect);
                return ChatInputOutcome::Consumed;
            }
            KeyCode::Down if !self.textarea.can_move_down() => {
                let effect = self.history.newer();
                self.apply_history_effect(effect);
                return ChatInputOutcome::Consumed;
            }
            _ => {}
        }

        match self.textarea.handle_key(key) {
            TextAreaOutcome::Consumed => {
                self.reset_history_navigation();
                self.sync_completion();
                ChatInputOutcome::Consumed
            }
            TextAreaOutcome::Unhandled => ChatInputOutcome::Unhandled,
        }
    }

    pub(crate) fn insert_text(&mut self, text: &str) {
        self.reset_history_navigation();
        self.textarea.insert_text(text);
        self.sync_completion();
    }

    pub(in crate::thread::composer) fn handle_paste(
        &mut self,
        pasted: String,
    ) -> Result<(), String> {
        if let Some(query) = self.history.query() {
            let effect = self.history.search(format!("{query}{pasted}"));
            self.apply_history_effect(effect);
            return Ok(());
        }
        self.reset_history_navigation();
        match self
            .attachments
            .try_attach_pasted_path(&mut self.textarea, &pasted)
        {
            ImagePasteOutcome::Attached => {}
            ImagePasteOutcome::NotImage => {
                self.pending_pastes.insert_text(&mut self.textarea, pasted)
            }
            ImagePasteOutcome::Rejected(error) => return Err(error),
        }
        self.sync_completion();
        Ok(())
    }

    pub(in crate::thread::composer) fn attach_image_bytes(
        &mut self,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        self.reset_history_navigation();
        self.attachments
            .attach_image_bytes(&mut self.textarea, bytes)?;
        self.sync_completion();
        Ok(())
    }

    pub(crate) fn text(&self) -> &str {
        self.textarea.text()
    }

    pub(crate) fn set_input_mode(&mut self, input_mode: ChatInputMode) {
        if self.input_mode == input_mode {
            return;
        }
        self.input_mode = input_mode;
        self.reset_history_navigation();
        self.vim.reset_draft();
    }

    pub(in crate::thread::composer) fn accepts_submission_key(&self) -> bool {
        self.input_mode == ChatInputMode::Standard || self.vim.accepts_submission_key()
    }

    pub(crate) fn prompt(&self) -> &'static str {
        match self.input_mode {
            ChatInputMode::Standard => "> ",
            ChatInputMode::Vim => self.vim.prompt(),
        }
    }

    pub(crate) fn cursor_display_width(&self) -> usize {
        self.textarea.cursor_display_width()
    }

    pub(crate) fn cursor_line(&self) -> usize {
        self.textarea.cursor_line()
    }

    pub(crate) fn argument_hint(&self) -> Option<&str> {
        self.completion
            .argument_hint(self.textarea.text(), self.textarea.cursor())
    }

    pub(crate) fn desired_height(&self, available_width: u16) -> u16 {
        const MAX_VISIBLE_LINES: usize = 6;
        let rows = wrap_input(
            self.textarea.text(),
            self.textarea.cursor_line(),
            self.textarea.cursor_display_width(),
            available_width,
        )
        .lines
        .len()
        .min(MAX_VISIBLE_LINES);
        u16::try_from(rows.saturating_add(2)).unwrap_or(u16::MAX)
    }

    pub(in crate::thread::composer) fn submit_current(&mut self) -> ChatInputOutcome {
        let command = self.current_command();
        let Some(submission) = self.prepare_submission() else {
            return ChatInputOutcome::Consumed;
        };
        self.record_submission_history(&submission);
        self.clear();
        match command {
            Some(command) => match into_command_invocation(submission, command) {
                Ok(invocation) => ChatInputOutcome::Command(invocation),
                Err(submission) => ChatInputOutcome::Submit(submission),
            },
            None => ChatInputOutcome::Submit(submission),
        }
    }

    pub(crate) fn queue_current(&mut self) -> ChatInputQueueOutcome {
        let command = self.current_command();
        let Some(submission) = self.prepare_submission() else {
            return ChatInputQueueOutcome::Consumed;
        };
        if let Some(command) = command {
            match into_command_invocation(submission.clone(), command) {
                Ok(invocation) if invocation.origin == SlashCommandOrigin::Local => {
                    self.record_submission_history(&submission);
                    self.clear();
                    return ChatInputQueueOutcome::Command(invocation);
                }
                Ok(invocation) => {
                    self.record_submission_history(&submission);
                    let draft = self.take_draft();
                    return ChatInputQueueOutcome::Queued(QueuedChatInput {
                        submission: invocation.into_forwarded_submission(),
                        draft,
                    });
                }
                Err(_) => {}
            }
        }

        self.record_submission_history(&submission);
        let draft = self.take_draft();
        ChatInputQueueOutcome::Queued(QueuedChatInput { submission, draft })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.prepare_submission().is_none()
    }

    pub(in crate::thread::composer) fn submission_display_text(&self) -> Option<String> {
        self.prepare_submission()
            .map(|submission| submission.display_text)
    }

    pub(crate) fn restore_queued(
        &mut self,
        queued: QueuedChatInput,
    ) -> Result<(), Box<QueuedChatInput>> {
        if !self.is_empty() {
            return Err(Box::new(queued));
        }
        let QueuedChatInput { draft, .. } = queued;
        self.restore_recovery_draft(draft);
        Ok(())
    }

    pub(crate) fn recovery_draft(&self) -> ChatInputDraft {
        ChatInputDraft {
            textarea: self.textarea.clone(),
            vim: self.vim.clone(),
            slash_command_element: self.slash_command_element,
            skill_bindings: self.skill_bindings.clone(),
            contexts: self.contexts.clone(),
            pending_pastes: self.pending_pastes.clone(),
            attachments: self.attachments.clone(),
        }
    }

    pub(crate) fn restore_recovery_draft(&mut self, draft: ChatInputDraft) {
        self.clear();
        self.textarea = draft.textarea;
        self.vim = draft.vim;
        self.slash_command_element = draft.slash_command_element;
        self.skill_bindings = draft.skill_bindings;
        self.contexts = draft.contexts;
        self.pending_pastes = draft.pending_pastes;
        self.attachments = draft.attachments;
        self.sync_completion();
    }

    pub(crate) fn submission_contains_skill(&self) -> bool {
        self.prepare_submission().is_some_and(|submission| {
            submission
                .input
                .iter()
                .any(|item| matches!(item, ChatInputItem::Skill { .. }))
        })
    }

    fn prepare_submission(&self) -> Option<ChatSubmission> {
        let raw_text = self.textarea.text();
        let display_text = self.pending_pastes.expand(&self.textarea);
        let display_text = display_text.trim().to_owned();
        let mut input = Vec::new();
        let mut selected_skills = Vec::new();
        let mut text = String::new();
        let mut cursor = 0;

        for (element_id, range) in self.textarea.elements() {
            text.push_str(&raw_text[cursor..range.start]);
            if let Some(replacement) = self.pending_pastes.replacement(element_id) {
                text.push_str(replacement);
            } else if let Some((_, name, content)) =
                self.contexts.iter().find(|(id, _, _)| *id == element_id)
            {
                push_text_input(&mut input, &mut text);
                input.push(ChatInputItem::Context {
                    name: name.clone(),
                    content: content.clone(),
                });
            } else if let Some(image) = self.attachments.attachment_item(element_id) {
                push_text_input(&mut input, &mut text);
                input.push(image.clone());
            } else {
                text.push_str(&raw_text[range.clone()]);
                if let Some(skill) = self
                    .skill_bindings
                    .iter()
                    .find(|(candidate, _)| *candidate == element_id)
                    .map(|(_, skill)| skill)
                    && !selected_skills.contains(skill)
                {
                    selected_skills.push(skill.clone());
                }
            }
            cursor = range.end;
        }
        text.push_str(&raw_text[cursor..]);
        push_text_input(&mut input, &mut text);
        input.splice(
            0..0,
            selected_skills
                .into_iter()
                .map(|skill| ChatInputItem::Skill { skill }),
        );

        (!input.is_empty()).then_some(ChatSubmission {
            display_text,
            input,
        })
    }

    fn take_editor_draft(&mut self) -> ChatInputDraft {
        ChatInputDraft {
            textarea: std::mem::replace(&mut self.textarea, TextArea::new()),
            vim: std::mem::take(&mut self.vim),
            slash_command_element: self.slash_command_element.take(),
            skill_bindings: std::mem::take(&mut self.skill_bindings),
            contexts: std::mem::take(&mut self.contexts),
            pending_pastes: std::mem::take(&mut self.pending_pastes),
            attachments: std::mem::take(&mut self.attachments),
        }
    }

    fn take_draft(&mut self) -> ChatInputDraft {
        self.generation = self.generation.wrapping_add(1);
        let draft = self.take_editor_draft();
        self.completion.clear();
        self.reset_history_navigation();
        draft
    }

    fn record_submission_history(&mut self, submission: &ChatSubmission) {
        if submission
            .input
            .iter()
            .all(|input| matches!(input, ChatInputItem::Text(_)))
        {
            let kind = if self.current_command().is_some() {
                InputKind::Command
            } else {
                InputKind::Agent
            };
            self.history.record(submission.display_text.clone(), kind);
        }
    }

    fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.textarea.clear();
        self.vim.reset_draft();
        self.slash_command_element = None;
        self.skill_bindings.clear();
        self.contexts.clear();
        self.pending_pastes.clear();
        self.attachments.clear();
        self.completion.clear();
        self.reset_history_navigation();
    }

    pub(crate) fn connect_history(&mut self, client: MessageHistory, thread_id: String) {
        self.history.connect(client);
        self.history.set_thread_id(thread_id);
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn connect_new_session_history(&mut self, client: MessageHistory) {
        self.history.connect(client);
    }

    pub(crate) fn history_unavailable(&mut self, error: String) {
        self.history.unavailable(error);
    }

    pub(crate) fn poll_history(&mut self) -> bool {
        let (changed, effect) = self.history.poll();
        self.apply_history_effect(effect);
        changed
    }

    pub(crate) fn history_status(&self) -> Option<String> {
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
            Some(query) => format!("History search: {query} · {state} · Enter edit · Esc cancel"),
            None => format!("History · {state} · Esc restore draft"),
        })
    }

    pub(crate) fn searching_history(&self) -> bool {
        self.history.query().is_some()
    }

    pub(crate) fn history_intercepts(&self, key: KeyEvent) -> bool {
        self.searching_history()
            || (self.history.active() && key.code == KeyCode::Esc)
            || (key.code == KeyCode::Char('r') && key.modifiers == KeyModifiers::CONTROL)
    }

    fn handle_history_search_key(&mut self, key: KeyEvent) -> ChatInputOutcome {
        let effect = match key.code {
            KeyCode::Esc => {
                self.history.reset();
                RecallEffect::Restore
            }
            KeyCode::Enter => {
                let effect = self.history.accept();
                if matches!(effect, RecallEffect::Keep) {
                    self.history_draft = None;
                }
                effect
            }
            KeyCode::Up => self.history.older(),
            KeyCode::Down => self.history.newer(),
            KeyCode::Char('r') if key.modifiers == KeyModifiers::CONTROL => self.history.older(),
            KeyCode::Char('c' | 'g') if key.modifiers == KeyModifiers::CONTROL => {
                self.history.reset();
                RecallEffect::Restore
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                let mut query = self.history.query().unwrap().to_owned();
                query.push(ch);
                self.history.search(query)
            }
            KeyCode::Backspace => {
                let mut query = self.history.query().unwrap().to_owned();
                query.pop();
                self.history.search(query)
            }
            _ => RecallEffect::Keep,
        };
        self.apply_history_effect(effect);
        if !self.searching_history() {
            self.sync_completion();
        }
        ChatInputOutcome::Consumed
    }

    fn apply_history_effect(&mut self, effect: RecallEffect) {
        match effect {
            RecallEffect::Keep => {}
            RecallEffect::Restore => {
                if let Some(draft) = self.history_draft.take() {
                    self.textarea = draft.textarea;
                    self.vim = draft.vim;
                    self.slash_command_element = draft.slash_command_element;
                    self.skill_bindings = draft.skill_bindings;
                    self.contexts = draft.contexts;
                    self.pending_pastes = draft.pending_pastes;
                    self.attachments = draft.attachments;
                    self.sync_completion();
                }
            }
            RecallEffect::Recall(text) => {
                if self.history_draft.is_none() {
                    self.history_draft = Some(self.take_editor_draft());
                }
                self.textarea.replace_text(&text.text);
                self.vim.reset_draft();
                self.pending_pastes.clear();
                self.attachments.clear();
                self.slash_command_element = None;
                self.skill_bindings.clear();
                self.contexts.clear();
                self.completion.clear();
            }
        }
    }

    pub(super) fn reset_history_navigation(&mut self) {
        self.history.reset();
        self.history_draft = None;
    }
}

fn push_text_input(input: &mut Vec<ChatInputItem>, text: &mut String) {
    let text = std::mem::take(text);
    let text = text.trim();
    if !text.is_empty() {
        input.push(ChatInputItem::Text(text.to_owned()));
    }
}

fn is_newline_key(key: KeyEvent) -> bool {
    (matches!(key.code, KeyCode::Enter)
        && key
            .modifiers
            .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT))
        || matches!(key.code, KeyCode::Char('j')) && key.modifiers == KeyModifiers::CONTROL
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod history_tests;
