use ash_ui_components::{ScrollCommand, ScrollDelta};
use std::time::Instant;
use zui::input::{ElementState, Key, KeyEvent, MouseButton, MouseScrollDelta, NamedKey};
use zui::ui::Point;
use zui::ui::{
    DispatchInvalidation, DispatchOutcome, ElementId, FocusDirection, InteractionFrame,
    NavigationAxis, UiDispatch,
};

use crate::WorkbenchApplication;
use crate::directory_picker::{
    DIRECTORY_SEARCH_INPUT, DirectoryPickerActivation, DirectoryPickerState, PICKER_ITEM_HEIGHT,
    directory_item_id,
};
use crate::session_host::EnvCwdSetResult;
use crate::terminal_selection::{read_clipboard_text, write_clipboard_text};
use ash_editor_host::FileEditorCloseRequest;
use ash_session::interaction::CONTEXT_WORKING_DIRECTORY;

const PICKER_ROWS_PER_WHEEL_STEP: f32 = 3.0;

impl WorkbenchApplication {
    pub(super) fn toggle_directory_picker(&mut self) {
        if self.directory_picker.is_open() {
            self.dismiss_directory_picker();
            return;
        }
        let anchor = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.element_bounds(CONTEXT_WORKING_DIRECTORY));
        let Some(anchor) = anchor else {
            return;
        };
        let restore_focus = self.ui_dispatch.focused();
        if let Err(error) = self.directory_picker.open(
            anchor,
            self.env.working_directory(),
            self.env.git_repository_root(),
            restore_focus,
        ) {
            eprintln!("could not open directory picker: {error}");
            return;
        }
        self.workbench.dismiss_tab_context_menu();
        self.git_branch_picker.dismiss();
        self.remote_connection_picker.dismiss();
        self.dismiss_remote_connection_manager();
        self.dismiss_remote_tunnel_manager();
        self.rebuild_and_focus_directory_search();
    }

    pub(super) fn activate_directory_picker_element(&mut self, id: ElementId) -> bool {
        let Some(index) = self.directory_picker.item_index(id) else {
            return false;
        };
        let activation = match self.directory_picker.activate(index) {
            Ok(Some(activation)) => activation,
            Ok(None) => return true,
            Err(error) => {
                eprintln!("could not browse directory: {error}");
                return true;
            }
        };
        match activation {
            DirectoryPickerActivation::BrowseChanged => {
                self.rebuild_and_focus_directory_search();
            }
            DirectoryPickerActivation::SelectDirectory(directory) => {
                if self.file_editor_host.request_dir_change()
                    == FileEditorCloseRequest::NeedsConfirmation
                {
                    eprintln!("could not change cwd while the active file has unsaved changes");
                    return true;
                }
                let switched = match self.session_runtime.as_ref() {
                    Some(session) => session.set_env_cwd(directory),
                    None => Err(anyhow::anyhow!("Agent session is unavailable")),
                };
                let switched = match switched {
                    Ok(switched) => switched,
                    Err(error) => {
                        eprintln!("could not change App Server cwd: {error}");
                        return true;
                    }
                };
                if !self.apply_cwd_change(switched) {
                    return true;
                }
                self.dismiss_directory_picker();
            }
        }
        true
    }

    pub(crate) fn apply_cwd_change(&mut self, switched: EnvCwdSetResult) -> bool {
        if let Err(error) = self.env.switch_working_directory(switched.cwd) {
            eprintln!("could not change cwd: {error}");
            return false;
        }
        self.app_server_client = None;
        self.env.apply_git_snapshot(None);
        self.refresh_dir_capabilities();
        self.language_service
            .set_dir_root(self.env.working_directory());
        self.file_editor_host.reset_for_dir_change();
        self.file_editor_input.reset_for_document_change();
        self.main_surface.show_agent();
        if !matches!(
            self.active_main_pane_kind(),
            Some(crate::PaneInputKind::Files | crate::PaneInputKind::Diff,)
        ) {
            let _ = self.bind_agent_pane();
        }
        self.pending_focus = Some(ash_session::interaction::COMPOSER);
        self.session_pane
            .set_working_directory(self.env.working_directory());
        true
    }

    pub(super) fn route_directory_picker_pointer_move(&mut self, point: Point) -> bool {
        if !self.directory_picker.is_open() {
            return false;
        }
        let outcome =
            self.presentation
                .as_ref()
                .map_or_else(DispatchOutcome::default, |presentation| {
                    update_directory_picker_pointer(
                        &mut self.ui_dispatch,
                        &self.directory_picker,
                        point,
                        presentation.interaction_frame(),
                    )
                });
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
        true
    }

    pub(super) fn route_directory_picker_button(
        &mut self,
        state: ElementState,
        button: MouseButton,
    ) -> bool {
        if !self.directory_picker.is_open() {
            return false;
        }
        if button != MouseButton::Left {
            if state == ElementState::Pressed {
                self.dismiss_directory_picker();
            }
            return true;
        }
        let target = self
            .cursor_position
            .zip(self.presentation.as_ref())
            .and_then(|(point, presentation)| presentation.interaction_frame().target_at(point));
        match state {
            ElementState::Pressed
                if target.is_some_and(|id| self.directory_picker.is_picker_element(id)) =>
            {
                self.primary_button_changed(state);
            }
            ElementState::Pressed => {
                self.dismiss_directory_picker();
            }
            ElementState::Released => {
                self.primary_button_changed(state);
            }
        }
        true
    }

    pub(super) fn route_directory_picker_wheel(&mut self, delta: MouseScrollDelta) -> bool {
        if !self.directory_picker.is_open() {
            return false;
        }
        let Some(metrics) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.directory_picker_scroll_metrics)
        else {
            return true;
        };
        if self
            .directory_picker
            .apply_scroll(directory_picker_scroll_command(delta), metrics)
        {
            self.project_directory_picker_hover_after_scroll();
            self.rebuild_overlay_on_next_redraw();
        }
        true
    }

    fn project_directory_picker_hover_after_scroll(&mut self) {
        let Some(point) = self.cursor_position else {
            return;
        };
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        let Some(viewport) = presentation.directory_picker_item_viewport else {
            return;
        };
        if !viewport.contains(point) {
            return;
        }
        let content_y =
            point.y - viewport.origin.y + self.directory_picker.scroll_state().vertical_offset();
        let index = (content_y / PICKER_ITEM_HEIGHT).floor() as usize;
        self.ui_dispatch
            .hover_element(directory_item_id(index), presentation.interaction_frame());
    }

    pub(super) fn route_directory_picker_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.directory_picker.is_open() {
            return false;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return true;
        };
        let frame = presentation.interaction_frame();
        if self.ui_dispatch.is_focused(DIRECTORY_SEARCH_INPUT) {
            match &event.logical_key {
                Key::Named(NamedKey::Escape) => {
                    self.dismiss_directory_picker();
                }
                Key::Named(NamedKey::ArrowDown) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Next,
                        NavigationAxis::Vertical,
                    );
                    self.apply_directory_picker_navigation(outcome);
                }
                Key::Named(NamedKey::ArrowUp) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Previous,
                        NavigationAxis::Vertical,
                    );
                    self.apply_directory_picker_navigation(outcome);
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
                    self.apply_directory_picker_navigation(outcome);
                }
                Key::Named(NamedKey::Enter) => {
                    if let Some(id) = self.directory_picker.first_action_id() {
                        self.activate_directory_picker_element(id);
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("c") =>
                {
                    if let Some(text) = self.directory_picker.selected_search_text()
                        && let Err(error) = write_clipboard_text(&self.clipboard, text.to_string())
                    {
                        eprintln!("could not copy directory search text: {error}");
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("v") =>
                {
                    match read_clipboard_text(&self.clipboard) {
                        Ok(text) => self
                            .directory_picker
                            .apply_search(zui::ui::TextInputCommand::Insert(text)),
                        Err(error) => {
                            eprintln!("could not paste directory search text: {error}")
                        }
                    }
                    self.directory_search_changed();
                }
                _ => {
                    if let Some(command) =
                        crate::terminal_input::text_input_command(event, self.modifiers)
                    {
                        self.directory_picker.apply_search(command);
                        self.directory_search_changed();
                    }
                }
            }
            return true;
        }
        let outcome = match &event.logical_key {
            Key::Named(NamedKey::Escape) => {
                self.dismiss_directory_picker();
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
        self.apply_directory_picker_navigation(outcome);
        true
    }

    pub(super) fn dismiss_directory_picker(&mut self) -> bool {
        if !self.directory_picker.is_open() {
            return false;
        }
        let restore_focus = self.directory_picker.dismiss();
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

    fn rebuild_and_focus_directory_search(&mut self) {
        self.rebuild_presentation();
        let focus_outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .focus_element(presentation.interaction_frame(), DIRECTORY_SEARCH_INPUT)
            })
            .unwrap_or_default();
        if focus_outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
    }

    fn directory_search_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }

    fn apply_directory_picker_navigation(&mut self, outcome: DispatchOutcome) {
        self.apply_dispatch_outcome(outcome);
        let Some(index) = self
            .ui_dispatch
            .focused()
            .and_then(|id| self.directory_picker.item_index(id))
        else {
            return;
        };
        let Some(metrics) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.directory_picker_scroll_metrics)
        else {
            return;
        };
        if self.directory_picker.ensure_item_visible(index, metrics) {
            self.rebuild_presentation();
            self.request_redraw();
        }
    }
}

fn is_shortcut(modifiers: zui::input::ModifiersState) -> bool {
    modifiers.control_key() || modifiers.super_key()
}

fn directory_picker_scroll_command(delta: MouseScrollDelta) -> ScrollCommand {
    let pixels = match delta {
        MouseScrollDelta::LineDelta(_, vertical) => {
            vertical * PICKER_ROWS_PER_WHEEL_STEP * PICKER_ITEM_HEIGHT
        }
        MouseScrollDelta::PixelDelta(position) => position.y as f32,
    };
    ScrollCommand::ByPixels(ScrollDelta::vertical(-pixels))
}

fn update_directory_picker_pointer(
    dispatch: &mut UiDispatch,
    state: &DirectoryPickerState,
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
