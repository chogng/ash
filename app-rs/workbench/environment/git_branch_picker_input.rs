use std::time::Instant;
use zui::input::{ElementState, Key, KeyEvent, MouseButton, NamedKey};
use zui::ui::Point;
use zui::ui::{
    DispatchInvalidation, DispatchOutcome, ElementId, FocusDirection, InteractionFrame,
    NavigationAxis, UiDispatch,
};

use crate::WorkbenchApplication;
use crate::git_branch_picker::{
    GIT_BRANCH_SEARCH_INPUT, GitBranchPickerActivation, GitBranchPickerState,
};
use crate::terminal_selection::{read_clipboard_text, write_clipboard_text};
use ash_session::interaction::CONTEXT_GIT_BRANCH;

impl WorkbenchApplication {
    pub(super) fn toggle_git_branch_picker(&mut self) {
        if self.git_branch_picker.is_open() {
            self.dismiss_git_branch_picker();
            return;
        }
        let anchor = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.element_bounds(CONTEXT_GIT_BRANCH));
        let Some(anchor) = anchor else {
            return;
        };
        let branches = match self.local_git_branches() {
            Ok(branches) => branches,
            Err(error) => {
                eprintln!("could not open Git branch picker: {error}");
                return;
            }
        };
        let restore_focus = self.ui_dispatch.focused();
        self.git_branch_picker.open(anchor, branches, restore_focus);
        self.workbench.dismiss_tab_context_menu();
        self.directory_picker.dismiss();
        self.remote_connection_picker.dismiss();
        self.dismiss_remote_connection_manager();
        self.dismiss_remote_tunnel_manager();
        self.rebuild_and_focus_git_branch_search();
    }

    pub(super) fn activate_git_branch_picker_element(&mut self, id: ElementId) -> bool {
        let Some(index) = self.git_branch_picker.item_index(id) else {
            return false;
        };
        let Some(activation) = self.git_branch_picker.activate(index) else {
            return true;
        };
        match activation {
            GitBranchPickerActivation::PageChanged => {
                self.rebuild_and_focus_git_branch_picker();
            }
            GitBranchPickerActivation::SelectBranch(branch) => {
                if branch.is_current() {
                    self.dismiss_git_branch_picker();
                    return true;
                }
                let snapshot = match self.switch_git_branch(branch.name().into()) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        eprintln!("could not switch Git branch: {error}");
                        self.git_branch_picker.set_switch_error();
                        self.rebuild_and_focus_git_branch_picker();
                        return true;
                    }
                };
                self.env.apply_git_snapshot(Some(&snapshot));
                self.refresh_dir_capabilities();
                self.refresh_files_from_app_server();
                self.dismiss_git_branch_picker();
            }
        }
        true
    }

    pub(super) fn route_git_branch_picker_pointer_move(&mut self, point: Point) -> bool {
        if !self.git_branch_picker.is_open() {
            return false;
        }
        let outcome =
            self.presentation
                .as_ref()
                .map_or_else(DispatchOutcome::default, |presentation| {
                    update_git_branch_picker_pointer(
                        &mut self.ui_dispatch,
                        &self.git_branch_picker,
                        point,
                        presentation.interaction_frame(),
                    )
                });
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
        true
    }

    pub(super) fn route_git_branch_picker_button(
        &mut self,
        state: ElementState,
        button: MouseButton,
    ) -> bool {
        if !self.git_branch_picker.is_open() {
            return false;
        }
        if button != MouseButton::Left {
            if state == ElementState::Pressed {
                self.dismiss_git_branch_picker();
            }
            return true;
        }
        let target = self
            .cursor_position
            .zip(self.presentation.as_ref())
            .and_then(|(point, presentation)| presentation.interaction_frame().target_at(point));
        match state {
            ElementState::Pressed
                if target.is_some_and(|id| self.git_branch_picker.is_picker_element(id)) =>
            {
                self.primary_button_changed(state);
            }
            ElementState::Pressed => {
                self.dismiss_git_branch_picker();
            }
            ElementState::Released => {
                self.primary_button_changed(state);
            }
        }
        true
    }

    pub(super) fn route_git_branch_picker_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.git_branch_picker.is_open() {
            return false;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return true;
        };
        let frame = presentation.interaction_frame();
        if self.ui_dispatch.is_focused(GIT_BRANCH_SEARCH_INPUT) {
            match &event.logical_key {
                Key::Named(NamedKey::Escape) => {
                    self.dismiss_git_branch_picker();
                }
                Key::Named(NamedKey::ArrowDown) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Next,
                        NavigationAxis::Vertical,
                    );
                    self.apply_dispatch_outcome(outcome);
                }
                Key::Named(NamedKey::ArrowUp) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Previous,
                        NavigationAxis::Vertical,
                    );
                    self.apply_dispatch_outcome(outcome);
                }
                Key::Named(NamedKey::Tab) => {
                    let direction = if self.modifiers.shift_key() {
                        FocusDirection::Previous
                    } else {
                        FocusDirection::Next
                    };
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        direction,
                        NavigationAxis::Vertical,
                    );
                    self.apply_dispatch_outcome(outcome);
                }
                Key::Named(NamedKey::Enter) => {
                    if let Some(id) = self.git_branch_picker.first_action_id() {
                        self.activate_git_branch_picker_element(id);
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("c") =>
                {
                    if let Some(text) = self.git_branch_picker.selected_search_text()
                        && let Err(error) = write_clipboard_text(&self.clipboard, text.to_string())
                    {
                        eprintln!("could not copy Git branch search text: {error}");
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("v") =>
                {
                    match read_clipboard_text(&self.clipboard) {
                        Ok(text) => self
                            .git_branch_picker
                            .apply_search(zui::ui::TextInputCommand::Insert(text)),
                        Err(error) => eprintln!("could not paste Git branch search text: {error}"),
                    }
                    self.git_branch_search_changed();
                }
                _ => {
                    if let Some(command) =
                        crate::terminal_input::text_input_command(event, self.modifiers)
                    {
                        self.git_branch_picker.apply_search(command);
                        self.git_branch_search_changed();
                    }
                }
            }
            return true;
        }
        let outcome = match &event.logical_key {
            Key::Named(NamedKey::Escape) => {
                self.dismiss_git_branch_picker();
                return true;
            }
            Key::Named(NamedKey::ArrowUp) => self.ui_dispatch.focus_within_group(
                frame,
                FocusDirection::Previous,
                NavigationAxis::Vertical,
            ),
            Key::Named(NamedKey::ArrowDown) => self.ui_dispatch.focus_within_group(
                frame,
                FocusDirection::Next,
                NavigationAxis::Vertical,
            ),
            Key::Named(NamedKey::Tab) => {
                let direction = if self.modifiers.shift_key() {
                    FocusDirection::Previous
                } else {
                    FocusDirection::Next
                };
                self.ui_dispatch
                    .focus_within_group(frame, direction, NavigationAxis::Vertical)
            }
            Key::Named(NamedKey::Enter) => self.ui_dispatch.activate_focused(frame),
            Key::Character(text) if text == " " => self.ui_dispatch.activate_focused(frame),
            _ => Default::default(),
        };
        self.apply_dispatch_outcome(outcome);
        true
    }

    pub(super) fn dismiss_git_branch_picker(&mut self) -> bool {
        if !self.git_branch_picker.is_open() {
            return false;
        }
        let restore_focus = self.git_branch_picker.dismiss();
        self.rebuild_presentation();
        if let Some(restore_focus) = restore_focus {
            let focus_outcome = self
                .presentation
                .as_ref()
                .map(|presentation| {
                    self.ui_dispatch
                        .focus_element(presentation.interaction_frame(), restore_focus)
                })
                .unwrap_or_default();
            if focus_outcome.invalidation == DispatchInvalidation::Paint {
                self.rebuild_presentation();
            }
        }
        self.update_cursor();
        self.request_redraw();
        true
    }

    fn rebuild_and_focus_git_branch_picker(&mut self) {
        self.rebuild_presentation();
        let focus_outcome = self
            .git_branch_picker
            .first_action_id()
            .zip(self.presentation.as_ref())
            .map(|(id, presentation)| {
                self.ui_dispatch
                    .focus_element(presentation.interaction_frame(), id)
            })
            .unwrap_or_default();
        if focus_outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.update_cursor();
        self.request_redraw();
    }

    fn rebuild_and_focus_git_branch_search(&mut self) {
        self.rebuild_presentation();
        let focus_outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .focus_element(presentation.interaction_frame(), GIT_BRANCH_SEARCH_INPUT)
            })
            .unwrap_or_default();
        if focus_outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
    }

    fn git_branch_search_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }
}

fn is_shortcut(modifiers: zui::input::ModifiersState) -> bool {
    modifiers.control_key() || modifiers.super_key()
}

fn update_git_branch_picker_pointer(
    dispatch: &mut UiDispatch,
    state: &GitBranchPickerState,
    point: Point,
    frame: &InteractionFrame,
) -> DispatchOutcome {
    let pointer_outcome = dispatch.pointer_moved(point, frame);
    let focus_outcome = frame
        .target_at(point)
        .filter(|target| state.item_index(*target).is_some())
        .map(|target| dispatch.focus_element(frame, target))
        .unwrap_or_default();
    DispatchOutcome {
        invalidation: if pointer_outcome.invalidation == DispatchInvalidation::Paint
            || focus_outcome.invalidation == DispatchInvalidation::Paint
        {
            DispatchInvalidation::Paint
        } else {
            DispatchInvalidation::None
        },
        intent: None,
        fragment: None,
    }
}
