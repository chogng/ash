use std::time::Instant;

use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorSelectionMode;
use ash_terminal::KeyModifiers;
use ash_terminal::TerminalCore;
use ash_terminal::TerminalKey;
use zui::input::ElementState;
use zui::input::Key;
use zui::input::KeyEvent;
use zui::input::ModifiersState;
use zui::input::NamedKey;
use zui::services::ClipboardHandle;
use zui::ui::TextInputCommand;
use zui::ui::TextInputSelectionMode;

use crate::SESSION_SEARCH_INPUT;
use crate::WorkbenchApplication;
use crate::keybindings::{
    WorkbenchKeybindingContext, WorkbenchKeybindingFacts, WorkbenchKeybindingResolution,
};
use crate::terminal_selection::{read_clipboard_text, write_clipboard_text};
use ash_editor_host::{FILE_EDITOR_FIND_INPUT, FILE_EDITOR_REPLACE_INPUT};
use ash_files::FILE_SEARCH_INPUT;
use ash_files::FilesAction;
use ash_session::interaction::{COMPOSER, COMPOSER_INTERACTION};
use ash_session::{ComposerInteractionActivation, SelectionDirection};
use ash_session::{ComposerRoute, ComposerSubmission};
use ash_settings::KEYBOARD_SHORTCUTS_SEARCH;
use ash_settings::SETTINGS_SEARCH_INPUT;
use zui::ui::{FocusDirection, NavigationAxis};

impl WorkbenchApplication {
    pub(super) fn keyboard_input(&mut self, event: KeyEvent) {
        if event.state != ElementState::Pressed {
            return;
        }
        if is_devtools_toggle_shortcut(&event, self.modifiers) {
            if let Some(window) = self.window.as_ref() {
                let _ = window.toggle_devtools();
            }
            return;
        }
        if self.quick_access.shortcuts_open() {
            if self.settings.route_keyboard_shortcut_input(
                &event,
                self.modifiers,
                self.keybindings.platform(),
                Instant::now(),
            ) {
                self.rebuild_presentation();
                self.request_redraw();
                return;
            }
            if event.logical_key == Key::Named(NamedKey::Escape) {
                self.quick_access.close();
                self.settings.reset_keyboard_shortcut_recording();
                self.rebuild_presentation();
                self.request_redraw();
                return;
            }
            if self.ui_dispatch.is_focused(KEYBOARD_SHORTCUTS_SEARCH)
                && let Some(command) = text_input_command(&event, self.modifiers)
            {
                self.quick_access.apply_query(command);
                self.caret_blink.activity(Instant::now());
                self.rebuild_presentation();
                self.update_ime_cursor_area();
                self.request_redraw();
                return;
            }
            let _ = self.dispatch_primary_keyboard_input(&event);
            return;
        }
        if self.settings.route_keyboard_shortcut_input(
            &event,
            self.modifiers,
            self.keybindings.platform(),
            Instant::now(),
        ) {
            self.rebuild_presentation();
            self.request_redraw();
            return;
        }
        if self.route_memories_keyboard(&event) {
            return;
        }
        if self.route_settings_keyboard(&event) {
            return;
        }
        if self.route_remote_tunnel_manager_keyboard(&event) {
            return;
        }
        if self.route_remote_connection_manager_keyboard(&event) {
            return;
        }
        if self.route_remote_connection_picker_keyboard(&event) {
            return;
        }
        if self.route_git_branch_picker_keyboard(&event) {
            return;
        }
        if self.route_directory_picker_keyboard(&event) {
            return;
        }
        if self.route_tab_context_menu_keyboard(&event) {
            return;
        }
        if self.route_scm_keyboard(&event) {
            return;
        }
        let direct_terminal = self.is_direct_terminal_input();
        let context = WorkbenchKeybindingContext::from_facts(WorkbenchKeybindingFacts {
            direct_terminal,
            terminal_surface_visible: self.main_surface.is_terminal(),
            tab_container_visible: self.workbench.tab_container_state().is_expanded(),
            inspector_visible: self.workbench.inspector_state().is_expanded(),
            file_search_visible: self.files.search_visible(),
            composer_route: match self.session_pane.composer_route() {
                ComposerRoute::Agent => "agent",
                ComposerRoute::Shell => "shell",
            },
        });
        match self.keybindings.resolve(&event, self.modifiers, &context) {
            WorkbenchKeybindingResolution::Command(command) => {
                self.dispatch_command(command);
                self.sync_input_focus();
                self.rebuild_presentation();
                self.request_redraw();
                return;
            }
            WorkbenchKeybindingResolution::Consumed => return,
            WorkbenchKeybindingResolution::NoMatch => {}
        }
        if direct_terminal {
            self.direct_terminal_keyboard_input(&event);
        } else if !self.file_editor_keyboard_input(&event)
            && !self.dispatch_primary_keyboard_input(&event)
        {
            if self.ui_dispatch.is_focused(SESSION_SEARCH_INPUT) {
                self.session_search_keyboard_input(&event);
            } else if self.ui_dispatch.is_focused(FILE_SEARCH_INPUT) {
                self.file_search_keyboard_input(&event);
            } else {
                self.composer_keyboard_input(&event);
            }
        }
    }

    fn route_settings_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.workbench.workbench().sidebar_part().is_settings()
            || event.state != ElementState::Pressed
        {
            return false;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.close_settings_tab();
            self.rebuild_presentation();
            self.request_redraw();
            return true;
        }
        if self.ui_dispatch.is_focused(SETTINGS_SEARCH_INPUT) {
            if let Some(command) = text_input_command(event, self.modifiers) {
                self.settings.apply_search(command);
                self.caret_blink.activity(Instant::now());
                self.rebuild_presentation();
                self.request_redraw();
            }
            return true;
        }
        if matches!(
            event.logical_key,
            Key::Named(
                NamedKey::Tab
                    | NamedKey::ArrowLeft
                    | NamedKey::ArrowRight
                    | NamedKey::ArrowUp
                    | NamedKey::ArrowDown
                    | NamedKey::Enter
            )
        ) {
            let handled = self.dispatch_primary_keyboard_input(event);
            if handled
                && let Some(focused) = self.ui_dispatch.focused()
                && let Some(viewport) = self.settings_keybindings_viewport()
                && self
                    .settings
                    .ensure_keybinding_visible(focused, viewport, Instant::now())
            {
                self.rebuild_presentation_on_next_redraw();
            }
            return handled;
        }
        false
    }

    fn file_search_keyboard_input(&mut self, event: &KeyEvent) {
        if event.logical_key == Key::Named(NamedKey::Escape) {
            if self.files.search_input().text().is_empty() {
                self.files.set_search_visible(false);
            } else {
                self.files.clear_search();
            }
            self.file_search_changed();
            return;
        }
        if let Some(command) = text_input_command(event, self.modifiers) {
            self.files.apply_search(command);
            self.file_search_changed();
        }
    }

    fn composer_keyboard_input(&mut self, event: &KeyEvent) {
        if self.modifiers.control_key()
            && matches!(&event.logical_key, Key::Character(key) if key.eq_ignore_ascii_case("r"))
        {
            self.session_pane.start_input_history_search();
            self.composer_changed();
            return;
        }
        if self.session_pane.searching_input_history() {
            match event.logical_key {
                Key::Named(NamedKey::Enter) => self.session_pane.accept_input_history(),
                Key::Named(NamedKey::Escape) => self.session_pane.cancel_input_history(),
                _ => {
                    if let Some(command) = code_editor_command(event, self.modifiers) {
                        self.session_pane.apply_composer_command(command);
                    }
                }
            }
            self.composer_changed();
            return;
        }
        if self.session_pane.composer_interaction_visible() {
            match event.logical_key {
                Key::Named(NamedKey::ArrowUp) => {
                    self.session_pane
                        .move_composer_interaction_selection(SelectionDirection::Previous);
                    self.reveal_composer_interaction_selection();
                    self.composer_changed();
                    return;
                }
                Key::Named(NamedKey::ArrowDown) => {
                    self.session_pane
                        .move_composer_interaction_selection(SelectionDirection::Next);
                    self.reveal_composer_interaction_selection();
                    self.composer_changed();
                    return;
                }
                Key::Named(NamedKey::Enter) => {
                    let activation = self.session_pane.activate_composer_interaction();
                    if activation.is_none() && !self.session_pane.composer_model_picker_visible() {
                        self.submit_composer();
                        return;
                    }
                    self.apply_composer_interaction_activation(activation);
                    return;
                }
                Key::Named(NamedKey::Tab) => {
                    if let Some(completion) = self.session_pane.complete_selected_slash() {
                        self.session_pane.set_composer_text(completion);
                    }
                    self.composer_changed();
                    return;
                }
                Key::Named(NamedKey::Escape) => {
                    self.session_pane.dismiss_composer_interaction();
                    self.composer_changed();
                    return;
                }
                _ if self.session_pane.composer_model_picker_visible() => {
                    return;
                }
                _ => {}
            }
        }
        if event.logical_key == Key::Named(NamedKey::Tab)
            && !self.modifiers.shift_key()
            && !self.modifiers.alt_key()
            && !self.modifiers.control_key()
            && !self.modifiers.super_key()
            && self.session_pane.accept_shell_suggestion()
        {
            self.composer_changed();
            return;
        }
        if event.logical_key == Key::Named(NamedKey::Enter) {
            if self.modifiers.shift_key() {
                self.session_pane
                    .apply_composer_command(CodeEditorCommand::Newline);
                self.composer_changed();
            } else {
                self.submit_composer();
            }
            return;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.session_pane.cancel_input_history();
            self.session_pane.dismiss_shell_suggestion();
            self.session_pane.cancel_composer_composition();
            self.composer_changed();
            return;
        }
        if let Some(command) = code_editor_command(event, self.modifiers) {
            self.session_pane.apply_composer_command(command);
            self.composer_changed();
        }
    }

    fn session_search_keyboard_input(&mut self, event: &KeyEvent) {
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.session_search.clear();
            self.session_search_changed();
            return;
        }
        if let Some(command) = text_input_command(event, self.modifiers) {
            self.session_search.apply(command);
            self.session_search_changed();
        }
    }

    pub(super) fn dispatch_primary_keyboard_input(&mut self, event: &KeyEvent) -> bool {
        if self.route_file_tree_keyboard(event) {
            return true;
        }
        if event.logical_key == Key::Named(NamedKey::Tab)
            && !self.modifiers.shift_key()
            && !self.modifiers.alt_key()
            && !self.modifiers.control_key()
            && !self.modifiers.super_key()
            && self.ui_dispatch.is_focused(COMPOSER)
            && self.session_pane.has_shell_suggestion()
        {
            return false;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return false;
        };
        let frame = presentation.interaction_frame();
        let outcome = if event.logical_key == Key::Named(NamedKey::Tab)
            && !self.session_pane.composer_interaction_visible()
        {
            let direction = if self.modifiers.shift_key() {
                FocusDirection::Previous
            } else {
                FocusDirection::Next
            };
            Some(self.ui_dispatch.focus_in_order(frame, direction))
        } else if !matches!(
            self.ui_dispatch.focused(),
            Some(COMPOSER | SESSION_SEARCH_INPUT | FILE_SEARCH_INPUT)
        ) {
            match &event.logical_key {
                Key::Named(NamedKey::ArrowLeft) => Some(self.ui_dispatch.focus_within_group(
                    frame,
                    FocusDirection::Previous,
                    NavigationAxis::Horizontal,
                )),
                Key::Named(NamedKey::ArrowRight) => Some(self.ui_dispatch.focus_within_group(
                    frame,
                    FocusDirection::Next,
                    NavigationAxis::Horizontal,
                )),
                Key::Named(NamedKey::ArrowUp) => Some(self.ui_dispatch.focus_within_group(
                    frame,
                    FocusDirection::Previous,
                    NavigationAxis::Vertical,
                )),
                Key::Named(NamedKey::ArrowDown) => Some(self.ui_dispatch.focus_within_group(
                    frame,
                    FocusDirection::Next,
                    NavigationAxis::Vertical,
                )),
                Key::Named(NamedKey::Enter) => Some(self.ui_dispatch.activate_focused(frame)),
                Key::Character(text) if text == " " => {
                    Some(self.ui_dispatch.activate_focused(frame))
                }
                Key::Named(NamedKey::Escape) => {
                    Some(self.ui_dispatch.focus_element(frame, COMPOSER))
                }
                _ => Some(Default::default()),
            }
        } else {
            None
        };
        let Some(outcome) = outcome else {
            return false;
        };
        self.apply_dispatch_outcome(outcome);
        true
    }

    fn route_file_tree_keyboard(&mut self, event: &KeyEvent) -> bool {
        let Some(focused) = self.ui_dispatch.focused() else {
            return false;
        };
        let navigation = match &event.logical_key {
            Key::Named(NamedKey::ArrowRight) => self.files.navigate_right(focused),
            Key::Named(NamedKey::ArrowLeft) => self.files.navigate_left(focused),
            _ => return false,
        };
        let Some(navigation) = navigation else {
            return false;
        };
        match navigation {
            FilesAction::Handled => {}
            FilesAction::StateChanged => {
                self.rebuild_presentation();
                self.request_redraw();
            }
            FilesAction::Focus(target) => {
                let outcome = self
                    .presentation
                    .as_ref()
                    .map(|presentation| {
                        self.ui_dispatch
                            .focus_element(presentation.interaction_frame(), target)
                    })
                    .unwrap_or_default();
                self.apply_dispatch_outcome(outcome);
            }
            FilesAction::OpenFile { path } => self.open_file(path),
            FilesAction::LoadChildren { element, path } => {
                self.load_file_tree_directory(element, path);
                self.rebuild_presentation();
                self.request_redraw();
            }
        }
        true
    }

    fn direct_terminal_keyboard_input(&mut self, event: &KeyEvent) {
        let Some(terminal) = self.active_terminal() else {
            return;
        };
        let input = encode_key_event(terminal.core(), event, self.modifiers);
        self.send_terminal_input(input, "could not send terminal input");
    }

    pub(super) fn submit_composer(&mut self) {
        let Some(submission) = self.session_pane.request_composer_submission() else {
            return;
        };
        match submission {
            ComposerSubmission::AgentMessage(text) => {
                let Some(session) = self.session_runtime.as_ref() else {
                    return;
                };
                if let Err(error) = session.submit_agent_message(text.clone()) {
                    eprintln!("could not submit Agent message: {error}");
                    return;
                }
                self.session_pane.mark_agent_message_submitted(&text);
            }
            ComposerSubmission::ShellCommand(command) => {
                let Some(session) = self.session_runtime.as_ref() else {
                    return;
                };
                if let Err(error) = session.submit_shell_command(command.clone()) {
                    eprintln!("could not submit Shell Turn: {error}");
                    return;
                }
                self.session_pane.mark_shell_command_submitted(&command);
            }
        }
        self.session_pane.clear_composer_after_submit();
        self.session_pane.timeline_scroll_mut().reset();
        self.composer_changed();
    }

    pub(super) fn activate_composer_interaction_item(&mut self, index: usize) -> bool {
        if !self.session_pane.select_composer_interaction_item(index) {
            return false;
        }
        let activation = self.session_pane.activate_composer_interaction();
        self.apply_composer_interaction_activation(activation);
        true
    }

    fn apply_composer_interaction_activation(
        &mut self,
        activation: Option<ComposerInteractionActivation>,
    ) {
        match activation {
            Some(ComposerInteractionActivation::ComposerText(text)) => {
                self.session_pane.set_composer_text(text);
            }
            Some(ComposerInteractionActivation::Model(model)) => {
                if let Some(session) = self.session_runtime.as_ref()
                    && let Err(error) = session.set_model(model)
                {
                    eprintln!("could not select Agent model: {error}");
                }
                self.session_pane.clear_composer_after_submit();
            }
            Some(ComposerInteractionActivation::ViewChanged) => {
                self.session_pane.reset_composer_interaction_scroll();
            }
            None => {}
        }
        self.composer_changed();
    }

    fn reveal_composer_interaction_selection(&mut self) {
        let Some(view) = self.session_pane.composer_interaction_view() else {
            return;
        };
        let Some(interaction_bounds) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.element_bounds(COMPOSER_INTERACTION))
        else {
            return;
        };
        let viewport = ash_session::interaction_list_bounds(interaction_bounds);
        let content = ash_session::interaction_content_size(viewport, view.items().len());
        let Some(selected) = view.selected() else {
            return;
        };
        let Some(command) = ash_session::interaction_selection_scroll_command(
            selected,
            view.items().len(),
            content.width,
        ) else {
            return;
        };
        self.session_pane
            .scroll_composer_interaction(command, viewport.size, content);
    }

    pub(super) fn copy_composer_selection(&mut self) -> bool {
        let Some(text) = self.session_pane.selected_composer_text() else {
            return false;
        };
        if let Err(error) = write_clipboard_text(&self.clipboard, text.to_string()) {
            eprintln!("could not copy command text: {error}");
        }
        true
    }

    pub(super) fn paste_into_composer(&mut self) {
        if self.session_pane.composer_model_picker_visible() {
            return;
        }
        let text = match read_clipboard_text(&self.clipboard) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("could not paste clipboard text: {error}");
                return;
            }
        };
        self.session_pane
            .apply_composer_command(CodeEditorCommand::Insert(text));
        self.composer_changed();
    }

    pub(super) fn paste_into_terminal(&mut self) -> bool {
        let Some(terminal) = self.active_terminal() else {
            return false;
        };
        let text = match read_clipboard_text(&self.clipboard) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("could not paste clipboard text: {error}");
                return true;
            }
        };
        let input = terminal.core().encode_paste(&text);
        self.send_terminal_input(input, "could not send terminal paste");
        true
    }

    pub(super) fn composer_changed(&mut self) {
        if self.session_pane.composer_interaction_visible() {
            self.reveal_composer_interaction_selection();
        }
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.update_ime_cursor_area();
        self.request_redraw();
    }

    pub(super) fn session_search_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.update_ime_cursor_area();
        self.request_redraw();
    }

    pub(super) fn file_search_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.update_ime_cursor_area();
        self.request_redraw();
    }

    pub(super) fn send_terminal_input(&mut self, input: Vec<u8>, error_context: &str) {
        if input.is_empty() {
            return;
        }
        if let Some(terminal) = self.active_terminal_mut()
            && let Err(error) = terminal.send_input(input)
        {
            eprintln!("{error_context}: {error}");
            return;
        }
        self.terminal_view_mut().scroll.reset();
        self.terminal_view_mut().selection.clear();
        self.rebuild_presentation();
        self.request_redraw();
    }

    pub(super) fn copy_keybinding_target(&mut self) {
        if self.ui_dispatch.is_focused(KEYBOARD_SHORTCUTS_SEARCH) {
            if let Some(text) = self.quick_access.selected_query_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy keyboard shortcut search text: {error}");
            }
            return;
        }
        if self.ui_dispatch.is_focused(SETTINGS_SEARCH_INPUT) {
            if let Some(text) = self.settings.selected_search_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy settings search text: {error}");
            }
            return;
        }
        if self.ui_dispatch.is_focused(SESSION_SEARCH_INPUT) {
            if let Some(text) = self.session_search.selected_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy session search text: {error}");
            }
            return;
        }
        if self.ui_dispatch.is_focused(FILE_SEARCH_INPUT) {
            if let Some(text) = self.files.selected_search_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy file search text: {error}");
            }
            return;
        }
        if self.ui_dispatch.is_focused(FILE_EDITOR_FIND_INPUT) {
            if let Some(text) = self.file_editor_search.selected_query_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy file editor find text: {error}");
            }
            return;
        }
        if self.ui_dispatch.is_focused(FILE_EDITOR_REPLACE_INPUT) {
            if let Some(text) = self.file_editor_search.selected_replacement_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.to_owned())
            {
                eprintln!("could not copy file editor replacement text: {error}");
            }
            return;
        }
        if self.copy_file_editor_selection() {
            return;
        }
        if !self.is_direct_terminal_input() && self.copy_composer_selection() {
            return;
        }
        self.copy_terminal_selection();
    }

    pub(super) fn paste_keybinding_target(&mut self) {
        if self.ui_dispatch.is_focused(KEYBOARD_SHORTCUTS_SEARCH) {
            let Some(text) = clipboard_text(
                &self.clipboard,
                "could not paste keyboard shortcut search text",
            ) else {
                return;
            };
            self.quick_access
                .apply_query(TextInputCommand::Insert(text));
            self.rebuild_presentation();
            self.update_ime_cursor_area();
            self.request_redraw();
            return;
        }
        if self.ui_dispatch.is_focused(SETTINGS_SEARCH_INPUT) {
            let Some(text) =
                clipboard_text(&self.clipboard, "could not paste settings search text")
            else {
                return;
            };
            self.settings.apply_search(TextInputCommand::Insert(text));
            self.rebuild_presentation();
            self.request_redraw();
            return;
        }
        if self.ui_dispatch.is_focused(SESSION_SEARCH_INPUT) {
            let Some(text) = clipboard_text(&self.clipboard, "could not paste session search text")
            else {
                return;
            };
            self.session_search.apply(TextInputCommand::Insert(text));
            self.session_search_changed();
            return;
        }
        if self.ui_dispatch.is_focused(FILE_SEARCH_INPUT) {
            let Some(text) = clipboard_text(&self.clipboard, "could not paste file search text")
            else {
                return;
            };
            self.files.apply_search(TextInputCommand::Insert(text));
            self.file_search_changed();
            return;
        }
        if self.ui_dispatch.is_focused(FILE_EDITOR_FIND_INPUT) {
            let Some(text) =
                clipboard_text(&self.clipboard, "could not paste file editor find text")
            else {
                return;
            };
            self.file_editor_search
                .apply_query(TextInputCommand::Insert(text));
            let query = self.file_editor_search.query();
            if !query.text().is_empty() {
                self.file_editor_host.find_nearest(&query);
            }
            self.file_editor_changed();
            return;
        }
        if self.ui_dispatch.is_focused(FILE_EDITOR_REPLACE_INPUT) {
            let Some(text) = clipboard_text(
                &self.clipboard,
                "could not paste file editor replacement text",
            ) else {
                return;
            };
            self.file_editor_search
                .apply_replacement(TextInputCommand::Insert(text));
            self.file_editor_changed();
            return;
        }
        if self.paste_into_file_editor() {
            return;
        }
        if self.is_direct_terminal_input() {
            self.paste_into_terminal();
        } else {
            self.paste_into_composer();
        }
    }

    fn is_direct_terminal_input(&self) -> bool {
        self.main_surface.is_terminal()
            && !self.ui_dispatch.is_focused(KEYBOARD_SHORTCUTS_SEARCH)
            && !self.ui_dispatch.is_focused(SETTINGS_SEARCH_INPUT)
            && !self.ui_dispatch.is_focused(SESSION_SEARCH_INPUT)
            && !self.ui_dispatch.is_focused(FILE_SEARCH_INPUT)
    }
}

fn clipboard_text(clipboard: &ClipboardHandle, error_context: &str) -> Option<String> {
    match read_clipboard_text(clipboard) {
        Ok(text) => Some(text),
        Err(error) => {
            eprintln!("{error_context}: {error}");
            None
        }
    }
}

pub(crate) fn text_input_command(
    event: &KeyEvent,
    modifiers: ModifiersState,
) -> Option<TextInputCommand> {
    let selection_mode = if modifiers.shift_key() {
        TextInputSelectionMode::Extend
    } else {
        TextInputSelectionMode::Move
    };
    let shortcut = modifiers.control_key() || modifiers.super_key();
    match &event.logical_key {
        Key::Named(NamedKey::Backspace) => Some(TextInputCommand::Backspace),
        Key::Named(NamedKey::Delete) => Some(TextInputCommand::DeleteForward),
        Key::Named(NamedKey::ArrowLeft) => Some(TextInputCommand::MoveLeft(selection_mode)),
        Key::Named(NamedKey::ArrowRight) => Some(TextInputCommand::MoveRight(selection_mode)),
        Key::Named(NamedKey::Home) => Some(TextInputCommand::MoveToStart(selection_mode)),
        Key::Named(NamedKey::End) => Some(TextInputCommand::MoveToEnd(selection_mode)),
        Key::Character(text) if shortcut && text.eq_ignore_ascii_case("a") => {
            Some(TextInputCommand::SelectAll)
        }
        _ if !shortcut => event
            .text
            .as_ref()
            .map(|text| TextInputCommand::Insert(text.to_string())),
        _ => None,
    }
}

pub(crate) fn code_editor_command(
    event: &KeyEvent,
    modifiers: ModifiersState,
) -> Option<CodeEditorCommand> {
    let selection_mode = if modifiers.shift_key() {
        CodeEditorSelectionMode::Extend
    } else {
        CodeEditorSelectionMode::Move
    };
    let shortcut = modifiers.control_key() || modifiers.super_key();
    let word_modifier = modifiers.control_key() || modifiers.alt_key();
    match &event.logical_key {
        Key::Named(NamedKey::Backspace) if word_modifier => {
            Some(CodeEditorCommand::DeleteWordBackward)
        }
        Key::Named(NamedKey::Backspace) => Some(CodeEditorCommand::Backspace),
        Key::Named(NamedKey::Delete) if word_modifier => Some(CodeEditorCommand::DeleteWordForward),
        Key::Named(NamedKey::Delete) => Some(CodeEditorCommand::DeleteForward),
        Key::Named(NamedKey::Enter) if shortcut && modifiers.shift_key() => {
            Some(CodeEditorCommand::InsertLineAbove)
        }
        Key::Named(NamedKey::Enter) if shortcut => Some(CodeEditorCommand::InsertLineBelow),
        Key::Named(NamedKey::ArrowLeft) if word_modifier => {
            Some(CodeEditorCommand::MoveWordLeft(selection_mode))
        }
        Key::Named(NamedKey::ArrowLeft) => Some(CodeEditorCommand::MoveLeft(selection_mode)),
        Key::Named(NamedKey::ArrowRight) if word_modifier => {
            Some(CodeEditorCommand::MoveWordRight(selection_mode))
        }
        Key::Named(NamedKey::ArrowRight) => Some(CodeEditorCommand::MoveRight(selection_mode)),
        Key::Named(NamedKey::ArrowUp) if modifiers.alt_key() && modifiers.shift_key() => {
            Some(CodeEditorCommand::DuplicateLinesAbove)
        }
        Key::Named(NamedKey::ArrowDown) if modifiers.alt_key() && modifiers.shift_key() => {
            Some(CodeEditorCommand::DuplicateLinesBelow)
        }
        Key::Named(NamedKey::ArrowUp) if modifiers.alt_key() => {
            Some(CodeEditorCommand::MoveLinesUp)
        }
        Key::Named(NamedKey::ArrowDown) if modifiers.alt_key() => {
            Some(CodeEditorCommand::MoveLinesDown)
        }
        Key::Named(NamedKey::ArrowUp) => Some(CodeEditorCommand::MoveUp(selection_mode)),
        Key::Named(NamedKey::ArrowDown) => Some(CodeEditorCommand::MoveDown(selection_mode)),
        Key::Named(NamedKey::PageUp) => Some(CodeEditorCommand::MovePageUp(selection_mode)),
        Key::Named(NamedKey::PageDown) => Some(CodeEditorCommand::MovePageDown(selection_mode)),
        Key::Named(NamedKey::Home) => Some(CodeEditorCommand::MoveToLineStart(selection_mode)),
        Key::Named(NamedKey::End) => Some(CodeEditorCommand::MoveToLineEnd(selection_mode)),
        Key::Named(NamedKey::Tab) if modifiers.shift_key() => Some(CodeEditorCommand::Outdent),
        Key::Named(NamedKey::Tab) => Some(CodeEditorCommand::Indent),
        Key::Character(text)
            if shortcut && modifiers.shift_key() && text.eq_ignore_ascii_case("k") =>
        {
            Some(CodeEditorCommand::DeleteLines)
        }
        Key::Character(text)
            if shortcut && modifiers.shift_key() && text.eq_ignore_ascii_case("d") =>
        {
            Some(CodeEditorCommand::DeleteEmptyLines)
        }
        Key::Character(text) if shortcut && text.eq_ignore_ascii_case("j") => {
            Some(CodeEditorCommand::JoinLines)
        }
        Key::Character(text) if shortcut && text == "/" => {
            Some(CodeEditorCommand::ToggleLineComment)
        }
        Key::Character(text) if shortcut && text.eq_ignore_ascii_case("a") => {
            Some(CodeEditorCommand::SelectAll)
        }
        Key::Character(text) if shortcut && text.eq_ignore_ascii_case("z") => {
            if modifiers.shift_key() {
                Some(CodeEditorCommand::Redo)
            } else {
                Some(CodeEditorCommand::Undo)
            }
        }
        _ if !shortcut => event
            .text
            .as_ref()
            .map(|text| CodeEditorCommand::Insert(text.to_string())),
        _ => None,
    }
}

fn encode_key_event(
    terminal: &TerminalCore,
    event: &KeyEvent,
    modifiers: ModifiersState,
) -> Vec<u8> {
    if modifiers.super_key() {
        return Vec::new();
    }
    let Some(key) = terminal_key(event) else {
        return Vec::new();
    };
    terminal.encode_key(key, terminal_modifiers(modifiers))
}

fn is_devtools_toggle_shortcut(event: &KeyEvent, modifiers: ModifiersState) -> bool {
    let Key::Character(character) = &event.logical_key else {
        return false;
    };
    let primary = if cfg!(target_os = "macos") {
        modifiers.super_key()
    } else {
        modifiers.control_key()
    };
    primary
        && modifiers.shift_key()
        && !modifiers.alt_key()
        && character.as_str().eq_ignore_ascii_case("i")
}

fn terminal_modifiers(modifiers: ModifiersState) -> KeyModifiers {
    let mut terminal = KeyModifiers::NONE;
    if modifiers.shift_key() {
        terminal = terminal.with_shift();
    }
    if modifiers.alt_key() {
        terminal = terminal.with_alt();
    }
    if modifiers.control_key() {
        terminal = terminal.with_control();
    }
    terminal
}

fn terminal_key(event: &KeyEvent) -> Option<TerminalKey<'_>> {
    match &event.logical_key {
        Key::Character(text) => Some(TerminalKey::Text(
            event.text.as_deref().unwrap_or(text.as_str()),
        )),
        Key::Named(NamedKey::Enter) => Some(TerminalKey::Enter),
        Key::Named(NamedKey::Tab) => Some(TerminalKey::Tab),
        Key::Named(NamedKey::Backspace) => Some(TerminalKey::Backspace),
        Key::Named(NamedKey::Escape) => Some(TerminalKey::Escape),
        Key::Named(NamedKey::ArrowUp) => Some(TerminalKey::ArrowUp),
        Key::Named(NamedKey::ArrowDown) => Some(TerminalKey::ArrowDown),
        Key::Named(NamedKey::ArrowRight) => Some(TerminalKey::ArrowRight),
        Key::Named(NamedKey::ArrowLeft) => Some(TerminalKey::ArrowLeft),
        Key::Named(NamedKey::Home) => Some(TerminalKey::Home),
        Key::Named(NamedKey::End) => Some(TerminalKey::End),
        Key::Named(NamedKey::Insert) => Some(TerminalKey::Insert),
        Key::Named(NamedKey::Delete) => Some(TerminalKey::Delete),
        Key::Named(NamedKey::PageUp) => Some(TerminalKey::PageUp),
        Key::Named(NamedKey::PageDown) => Some(TerminalKey::PageDown),
        Key::Named(NamedKey::F1) => Some(TerminalKey::F1),
        Key::Named(NamedKey::F2) => Some(TerminalKey::F2),
        Key::Named(NamedKey::F3) => Some(TerminalKey::F3),
        Key::Named(NamedKey::F4) => Some(TerminalKey::F4),
        Key::Named(NamedKey::F5) => Some(TerminalKey::F5),
        Key::Named(NamedKey::F6) => Some(TerminalKey::F6),
        Key::Named(NamedKey::F7) => Some(TerminalKey::F7),
        Key::Named(NamedKey::F8) => Some(TerminalKey::F8),
        Key::Named(NamedKey::F9) => Some(TerminalKey::F9),
        Key::Named(NamedKey::F10) => Some(TerminalKey::F10),
        Key::Named(NamedKey::F11) => Some(TerminalKey::F11),
        Key::Named(NamedKey::F12) => Some(TerminalKey::F12),
        _ => None,
    }
}
