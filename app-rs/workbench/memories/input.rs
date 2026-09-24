use crate::WorkbenchApplication;
use crate::memories::*;
use ash_editor::CodeEditorCommand;
use zui::input::ElementState;
use zui::input::Key;
use zui::input::KeyEvent;
use zui::input::NamedKey;
use zui::ui::ElementId;
use zui::ui::FocusDirection;
use zui::ui::NavigationAxis;
use zui::ui::TextInputCommand;

impl WorkbenchApplication {
    pub(crate) fn open_memories(&mut self) {
        self.quick_access.close();
        self.settings.reset_keyboard_shortcut_recording();
        self.directory_picker.dismiss();
        self.git_branch_picker.dismiss();
        self.remote_connection_picker.dismiss();
        self.dismiss_remote_connection_manager();
        self.dismiss_remote_tunnel_manager();
        let thread = self
            .session_pane
            .thread()
            .map(|thread| thread.thread_id.clone());
        self.memories.open(
            self.app_server_client.clone(),
            thread,
            self.ui_dispatch.focused(),
        );
        self.pending_focus = Some(QUERY);
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }
    pub(crate) fn activate_memory_element(&mut self, id: ElementId) -> bool {
        if !self.memories.state.open {
            return false;
        }
        if id == CLOSE {
            let restore = self.memories.state.restore_focus;
            if self.memories.close() {
                self.pending_focus = restore;
            }
        } else if !self.memories.state.busy {
            if id == SAVE {
                self.save_memory();
            } else if id == HELP {
                self.memories.state.status = "Tab: move controls. Enter: activate. Ctrl/Cmd+S: save. Reading and model saving are separate permissions. Editing takes user ownership. Escape closes.".into();
            } else if id == REFERENCE {
                let value = self.memories.state.query.text().to_owned();
                self.memories.request(Request::Reference(value));
            } else if id == READING || id == SAVING {
                if let Some(mut policy) = self.memories.state.policy().cloned() {
                    if id == READING {
                        policy.automatic_read = match policy.automatic_read {
                            memories::MemoryReadMode::Disabled => {
                                memories::MemoryReadMode::FirstInvocation
                            }
                            memories::MemoryReadMode::FirstInvocation => {
                                memories::MemoryReadMode::Disabled
                            }
                        };
                    } else {
                        policy.model_write = match policy.model_write {
                            memories::MemoryWriteMode::Disabled => {
                                memories::MemoryWriteMode::Enabled
                            }
                            memories::MemoryWriteMode::Enabled => {
                                memories::MemoryWriteMode::Disabled
                            }
                        };
                    }
                    self.memories.request(Request::Policy(policy));
                }
            } else if id == DELETE {
                if self.memories.state.confirm_delete {
                    if let Some(memory) = self.memories.state.selected.clone() {
                        self.memories.request(Request::Delete {
                            command_id: self.memories.state.mutation_id.clone(),
                            memory,
                        });
                    }
                } else {
                    self.memories.state.confirm_delete = true;
                    self.memories.state.status = "Click Confirm delete to remove this saved memory. Conversation history is retained.".into();
                }
            } else if self.memories.state.dirty && id != BODY && id != TITLE && id != QUERY {
                self.memories.state.status = "Save the memory draft before changing the selection, or close twice to discard.".into();
            } else if id == NEW {
                self.memories.state.clear_draft();
                self.pending_focus = Some(TITLE);
            } else if id == SCOPE_NEXT && !self.memories.state.scopes.is_empty() {
                self.memories.state.scope_index =
                    (self.memories.state.scope_index + 1) % self.memories.state.scopes.len();
                self.memories.state.clear_draft();
                self.memories.reload();
            } else if id == BODY {
                if let Some((point, bounds)) = self.cursor_position.zip(
                    self.presentation
                        .as_ref()
                        .and_then(|presentation| presentation.element_bounds(BODY)),
                ) {
                    let position = body_editor(
                        &self.memories.state,
                        bounds,
                        &self.code_editor_style,
                        zui::ui::CaretVisibility::Visible,
                    )
                    .text_position_at(point);
                    if let Some(position) = position {
                        self.memories
                            .state
                            .body
                            .move_to(position, ash_editor::CodeEditorSelectionMode::Move);
                    }
                }
            } else if id == SEARCH {
                self.memories.reload();
            } else if id == REFRESH {
                self.memories.request(Request::Scopes);
            } else if id == NEXT {
                self.memories.load_next_page();
            } else if let Some(entry) = self
                .memories
                .state
                .entries
                .iter()
                .enumerate()
                .find(|(index, _)| row_id(*index) == id)
                .map(|(_, entry)| entry.clone())
            {
                self.memories.request(Request::Read(entry));
            }
        }
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
        true
    }
    fn save_memory(&mut self) {
        if self.memories.state.read_only {
            return;
        }
        if let Some(policy) = self.memories.state.policy() {
            let request = Request::Save {
                command_id: self.memories.state.mutation_id.clone(),
                scope: policy.scope.clone(),
                selected: self.memories.state.selected.clone(),
                title: self.memories.state.title.text().into(),
                body: self.memories.state.body.text().into(),
            };
            self.memories.request(request);
        }
    }
    pub(crate) fn route_memories_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.memories.state.open {
            return false;
        }
        if event.state != ElementState::Pressed {
            return true;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.activate_memory_element(CLOSE);
            return true;
        }
        if self.memories.state.busy {
            return true;
        }
        let shortcut = self.modifiers.control_key() || self.modifiers.super_key();
        if shortcut
            && matches!(&event.logical_key, Key::Character(text) if text.eq_ignore_ascii_case("s"))
        {
            self.activate_memory_element(SAVE);
            return true;
        }
        let focus = self.ui_dispatch.focused();
        if event.logical_key == Key::Named(NamedKey::Tab) {
            if let Some(presentation) = &self.presentation {
                let outcome = self.ui_dispatch.focus_within_group(
                    presentation.interaction_frame(),
                    if self.modifiers.shift_key() {
                        FocusDirection::Previous
                    } else {
                        FocusDirection::Next
                    },
                    NavigationAxis::Vertical,
                );
                self.apply_dispatch_outcome(outcome);
            }
        } else if matches!(focus, Some(BODY | TITLE | QUERY)) {
            let focus = focus.expect("input focus");
            if shortcut
                && matches!(&event.logical_key, Key::Character(text) if text.eq_ignore_ascii_case("c"))
            {
                let text = if focus == BODY {
                    self.memories.state.body.selected_text()
                } else if focus == TITLE {
                    self.memories.state.title.selected_text()
                } else {
                    self.memories.state.query.selected_text()
                };
                if let Some(text) = text {
                    if let Err(error) = crate::terminal_selection::write_clipboard_text(
                        &self.clipboard,
                        text.into(),
                    ) {
                        self.memories.state.status = error.to_string();
                    }
                }
            } else if shortcut
                && matches!(&event.logical_key, Key::Character(text) if text.eq_ignore_ascii_case("v"))
            {
                if !self.memories.state.read_only || focus == QUERY {
                    match crate::terminal_selection::read_clipboard_text(&self.clipboard) {
                        Ok(text) => {
                            if focus == BODY {
                                self.memories
                                    .state
                                    .body
                                    .apply(CodeEditorCommand::Insert(text));
                            } else if focus == TITLE {
                                self.memories
                                    .state
                                    .title
                                    .apply(TextInputCommand::Insert(text));
                            } else {
                                self.memories
                                    .state
                                    .query
                                    .apply(TextInputCommand::Insert(text));
                            }
                            self.memories.state.dirty |= focus != QUERY;
                        }
                        Err(error) => self.memories.state.status = error.to_string(),
                    }
                }
            } else if focus == BODY {
                if let Some(command) =
                    crate::terminal_input::code_editor_command(event, self.modifiers)
                {
                    let before = self.memories.state.body.text().to_owned();
                    if !self.memories.state.read_only
                        || matches!(
                            command,
                            CodeEditorCommand::SelectAll
                                | CodeEditorCommand::MoveLeft(_)
                                | CodeEditorCommand::MoveRight(_)
                                | CodeEditorCommand::MoveUp(_)
                                | CodeEditorCommand::MoveDown(_)
                        )
                    {
                        if let Some(bounds) = self
                            .presentation
                            .as_ref()
                            .and_then(|presentation| presentation.element_bounds(BODY))
                        {
                            let navigation = body_editor(
                                &self.memories.state,
                                bounds,
                                &self.code_editor_style,
                                zui::ui::CaretVisibility::Visible,
                            )
                            .navigation();
                            self.memories.state.body.apply_in_view(command, navigation);
                        }
                    }
                    self.memories.state.dirty |= before != self.memories.state.body.text();
                }
                if let Some(bounds) = self
                    .presentation
                    .as_ref()
                    .and_then(|presentation| presentation.element_bounds(BODY))
                {
                    let editor = body_editor(
                        &self.memories.state,
                        bounds,
                        &self.code_editor_style,
                        zui::ui::CaretVisibility::Visible,
                    );
                    let info = (
                        editor.caret_visual_row(),
                        editor.visual_row_count(),
                        editor.visible_row_capacity(),
                    );
                    if let Some(row) = info.0 {
                        self.memories.state.viewport.reveal_row(row, info.1, info.2);
                    }
                }
            } else if !self.memories.state.read_only || focus == QUERY {
                if let Some(command) =
                    crate::terminal_input::text_input_command(event, self.modifiers)
                {
                    let input = if focus == TITLE {
                        &mut self.memories.state.title
                    } else {
                        &mut self.memories.state.query
                    };
                    let before = input.text().to_owned();
                    input.apply(command);
                    self.memories.state.dirty |= focus == TITLE && before != input.text();
                }
            }
        } else if event.logical_key == Key::Named(NamedKey::Enter)
            || matches!(&event.logical_key, Key::Character(text) if text == " ")
        {
            if let Some(id) = focus {
                self.activate_memory_element(id);
            }
        }
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
        true
    }
}
