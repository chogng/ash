use std::time::Instant;

use ash_remote_connections::RemoteConnectionCatalog;
use ash_settings::REMOTE_CONNECTION_ITEM_HEIGHT;
use ash_settings::REMOTE_CONNECTION_SEARCH_INPUT;
use ash_settings::RemoteConnectionPickerAction;
use ash_settings::RemoteConnectionPickerState;
use ash_settings::remote_connection_item_id;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollDelta;
use zui::input::ElementState;
use zui::input::Key;
use zui::input::KeyEvent;
use zui::input::MouseButton;
use zui::input::MouseScrollDelta;
use zui::input::NamedKey;
use zui::ui::DispatchInvalidation;
use zui::ui::DispatchOutcome;
use zui::ui::ElementId;
use zui::ui::FocusDirection;
use zui::ui::InteractionFrame;
use zui::ui::NavigationAxis;
use zui::ui::Point;
use zui::ui::UiDispatch;

use crate::WorkbenchApplication;
use crate::terminal_selection::read_clipboard_text;
use crate::terminal_selection::write_clipboard_text;
use ash_session::interaction::CONTEXT_LOCATION;

const PICKER_ROWS_PER_WHEEL_STEP: f32 = 3.0;

impl WorkbenchApplication {
    pub(super) fn toggle_remote_connection_picker(&mut self) {
        if self.remote_connection_picker.is_open() {
            self.dismiss_remote_connection_picker();
            return;
        }
        let anchor = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.element_bounds(CONTEXT_LOCATION));
        let Some(anchor) = anchor else {
            return;
        };
        let connections = match ash_utils_home_dir::find_ash_home()
            .map_err(|error| error.to_string())
            .and_then(|root| {
                let catalog = RemoteConnectionCatalog::from_profile_root(root);
                catalog
                    .connections()
                    .map_err(|error| format!("{}: {error}", catalog.path().display()))
            }) {
            Ok(connections) => connections,
            Err(error) => {
                eprintln!("could not load Remote connections: {error}");
                return;
            }
        };
        let restore_focus = self.ui_dispatch.focused();
        self.remote_connection_picker.open(
            anchor,
            connections,
            self.remote_tunnel_host.is_some(),
            restore_focus,
        );
        self.workbench.dismiss_tab_context_menu();
        self.git_branch_picker.dismiss();
        self.directory_picker.dismiss();
        self.dismiss_remote_connection_manager();
        self.dismiss_remote_tunnel_manager();
        self.rebuild_and_focus_remote_connection_search();
    }

    pub(super) fn activate_remote_connection_picker_element(&mut self, id: ElementId) -> bool {
        let Some(index) = self.remote_connection_picker.item_index(id) else {
            return false;
        };
        let Some(action) = self.remote_connection_picker.activate(index) else {
            return true;
        };
        match action {
            RemoteConnectionPickerAction::Manage => {
                let restore_focus = self.remote_connection_picker.dismiss();
                self.open_remote_connection_manager(restore_focus);
            }
            RemoteConnectionPickerAction::ManageTunnels => {
                let restore_focus = self.remote_connection_picker.dismiss();
                self.open_remote_tunnel_manager(restore_focus);
            }
            RemoteConnectionPickerAction::Connect(connection) => {
                let restore_focus = self.remote_connection_picker.dismiss();
                self.open_remote_connection_manager_and_connect(connection, restore_focus);
            }
        }
        true
    }

    pub(super) fn route_remote_connection_picker_pointer_move(&mut self, point: Point) -> bool {
        if !self.remote_connection_picker.is_open() {
            return false;
        }
        let outcome =
            self.presentation
                .as_ref()
                .map_or_else(DispatchOutcome::default, |presentation| {
                    update_remote_connection_picker_pointer(
                        &mut self.ui_dispatch,
                        &self.remote_connection_picker,
                        point,
                        presentation.interaction_frame(),
                    )
                });
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
        true
    }

    pub(super) fn route_remote_connection_picker_button(
        &mut self,
        state: ElementState,
        button: MouseButton,
    ) -> bool {
        if !self.remote_connection_picker.is_open() {
            return false;
        }
        if button != MouseButton::Left {
            if state == ElementState::Pressed {
                self.dismiss_remote_connection_picker();
            }
            return true;
        }
        let target = self
            .cursor_position
            .zip(self.presentation.as_ref())
            .and_then(|(point, presentation)| presentation.interaction_frame().target_at(point));
        match state {
            ElementState::Pressed
                if target.is_some_and(|id| self.remote_connection_picker.is_picker_element(id)) =>
            {
                self.primary_button_changed(state);
            }
            ElementState::Pressed => {
                self.dismiss_remote_connection_picker();
            }
            ElementState::Released => {
                self.primary_button_changed(state);
            }
        }
        true
    }

    pub(super) fn route_remote_connection_picker_wheel(&mut self, delta: MouseScrollDelta) -> bool {
        if !self.remote_connection_picker.is_open() {
            return false;
        }
        let Some(metrics) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.remote_connection_picker_scroll_metrics)
        else {
            return true;
        };
        if self
            .remote_connection_picker
            .apply_scroll(remote_connection_picker_scroll_command(delta), metrics)
        {
            self.project_remote_connection_picker_hover_after_scroll();
            self.rebuild_overlay_on_next_redraw();
        }
        true
    }

    fn project_remote_connection_picker_hover_after_scroll(&mut self) {
        let Some(point) = self.cursor_position else {
            return;
        };
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        let Some(viewport) = presentation.remote_connection_picker_item_viewport else {
            return;
        };
        if !viewport.contains(point) {
            return;
        }
        let content_y = point.y - viewport.origin.y
            + self
                .remote_connection_picker
                .scroll_state()
                .vertical_offset();
        let index = (content_y / REMOTE_CONNECTION_ITEM_HEIGHT).floor() as usize;
        self.ui_dispatch.hover_element(
            remote_connection_item_id(index),
            presentation.interaction_frame(),
        );
    }

    pub(super) fn route_remote_connection_picker_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.remote_connection_picker.is_open() {
            return false;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return true;
        };
        let frame = presentation.interaction_frame();
        if self.ui_dispatch.is_focused(REMOTE_CONNECTION_SEARCH_INPUT) {
            match &event.logical_key {
                Key::Named(NamedKey::Escape) => {
                    self.dismiss_remote_connection_picker();
                }
                Key::Named(NamedKey::ArrowDown) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Next,
                        NavigationAxis::Vertical,
                    );
                    self.apply_remote_connection_picker_navigation(outcome);
                }
                Key::Named(NamedKey::ArrowUp) => {
                    let outcome = self.ui_dispatch.focus_within_group(
                        frame,
                        FocusDirection::Previous,
                        NavigationAxis::Vertical,
                    );
                    self.apply_remote_connection_picker_navigation(outcome);
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
                    self.apply_remote_connection_picker_navigation(outcome);
                }
                Key::Named(NamedKey::Enter) => {
                    if let Some(id) = self.remote_connection_picker.first_action_id() {
                        self.activate_remote_connection_picker_element(id);
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("c") =>
                {
                    if let Some(text) = self.remote_connection_picker.selected_search_text()
                        && let Err(error) = write_clipboard_text(&self.clipboard, text.into())
                    {
                        eprintln!("could not copy Remote connection search text: {error}");
                    }
                }
                Key::Character(text)
                    if is_shortcut(self.modifiers) && text.eq_ignore_ascii_case("v") =>
                {
                    match read_clipboard_text(&self.clipboard) {
                        Ok(text) => self
                            .remote_connection_picker
                            .apply_search(zui::ui::TextInputCommand::Insert(text)),
                        Err(error) => {
                            eprintln!("could not paste Remote connection search text: {error}")
                        }
                    }
                    self.remote_connection_search_changed();
                }
                _ => {
                    if let Some(command) =
                        crate::terminal_input::text_input_command(event, self.modifiers)
                    {
                        self.remote_connection_picker.apply_search(command);
                        self.remote_connection_search_changed();
                    }
                }
            }
            return true;
        }
        let outcome = match &event.logical_key {
            Key::Named(NamedKey::Escape) => {
                self.dismiss_remote_connection_picker();
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
        self.apply_remote_connection_picker_navigation(outcome);
        true
    }

    pub(super) fn dismiss_remote_connection_picker(&mut self) -> bool {
        if !self.remote_connection_picker.is_open() {
            return false;
        }
        let restore_focus = self.remote_connection_picker.dismiss();
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

    fn rebuild_and_focus_remote_connection_search(&mut self) {
        self.rebuild_presentation();
        let focus_outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch.focus_element(
                    presentation.interaction_frame(),
                    REMOTE_CONNECTION_SEARCH_INPUT,
                )
            })
            .unwrap_or_default();
        if focus_outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
    }

    fn remote_connection_search_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }

    fn apply_remote_connection_picker_navigation(&mut self, outcome: DispatchOutcome) {
        self.apply_dispatch_outcome(outcome);
        let Some(index) = self
            .ui_dispatch
            .focused()
            .and_then(|id| self.remote_connection_picker.item_index(id))
        else {
            return;
        };
        let Some(metrics) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.remote_connection_picker_scroll_metrics)
        else {
            return;
        };
        if self
            .remote_connection_picker
            .ensure_item_visible(index, metrics)
        {
            self.rebuild_presentation();
            self.request_redraw();
        }
    }
}

fn is_shortcut(modifiers: zui::input::ModifiersState) -> bool {
    modifiers.control_key() || modifiers.super_key()
}

fn remote_connection_picker_scroll_command(delta: MouseScrollDelta) -> ScrollCommand {
    let pixels = match delta {
        MouseScrollDelta::LineDelta(_, vertical) => {
            vertical * PICKER_ROWS_PER_WHEEL_STEP * REMOTE_CONNECTION_ITEM_HEIGHT
        }
        MouseScrollDelta::PixelDelta(position) => position.y as f32,
    };
    ScrollCommand::ByPixels(ScrollDelta::vertical(-pixels))
}

fn update_remote_connection_picker_pointer(
    dispatch: &mut UiDispatch,
    state: &RemoteConnectionPickerState,
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
