use std::time::Instant;

use ash_remote_connections::RemoteConnectionCatalog;
use ash_remote_connections::RemoteConnectionName;
use ash_remote_connections::RemoteConnectionSaveMode;
use ash_settings::REMOTE_CONNECTION_MANAGER;
use ash_settings::REMOTE_CONNECTION_MANAGER_CLOSE;
use ash_settings::REMOTE_CONNECTION_MANAGER_CONNECT;
use ash_settings::REMOTE_CONNECTION_MANAGER_DELETE;
use ash_settings::REMOTE_CONNECTION_MANAGER_DIRECTORY;
use ash_settings::REMOTE_CONNECTION_MANAGER_HOST;
use ash_settings::REMOTE_CONNECTION_MANAGER_NAME;
use ash_settings::REMOTE_CONNECTION_MANAGER_NEW;
use ash_settings::REMOTE_CONNECTION_MANAGER_SAVE;
use ash_settings::RemoteConnectionManagerField;
use ash_settings::RemoteConnectionSaveRequest;
use ash_settings::remote_connection_manager_item_id;
use ash_settings::remote_connection_manager_item_index;
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
use zui::ui::NavigationAxis;
use zui::ui::Point;
use zui::ui::TextInputCommand;

use crate::WorkbenchApplication;
use crate::terminal_input::text_input_command;
use crate::terminal_selection::read_clipboard_text;
use crate::terminal_selection::write_clipboard_text;

#[path = "remote_connection_manager_input_support.rs"]
mod support;
use support::is_remote_connection_manager_element;
use support::remote_connection_manager_scroll_command;

impl WorkbenchApplication {
    pub(super) fn open_remote_connection_settings(&mut self) -> bool {
        if self.remote_connection_manager.is_settings() {
            self.rebuild_and_focus_remote_connection_manager();
            return true;
        }
        self.dismiss_remote_tunnel_manager();
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
                self.remote_connection_manager.open_settings(Vec::new());
                self.remote_connection_manager
                    .save_failed(format!("Could not load Remote connections: {error}"));
                self.rebuild_and_focus_remote_connection_manager();
                return true;
            }
        };
        self.remote_connection_manager.open_settings(connections);
        self.rebuild_and_focus_remote_connection_manager();
        true
    }

    pub(super) fn open_remote_connection_manager(&mut self, restore_focus: Option<ElementId>) {
        self.open_remote_connection_manager_selected(restore_focus, None);
    }

    pub(super) fn open_remote_connection_manager_and_connect(
        &mut self,
        name: RemoteConnectionName,
        restore_focus: Option<ElementId>,
    ) {
        if self.open_remote_connection_manager_selected(restore_focus, Some(&name)) {
            self.connect_remote_connection_manager();
        }
    }

    fn open_remote_connection_manager_selected(
        &mut self,
        restore_focus: Option<ElementId>,
        selected: Option<&RemoteConnectionName>,
    ) -> bool {
        self.dismiss_remote_tunnel_manager();
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
                return false;
            }
        };
        self.remote_connection_manager
            .open(connections, restore_focus);
        if let Some(selected) = selected {
            let Some(index) = self
                .remote_connection_manager
                .connections()
                .iter()
                .position(|entry| entry.name() == selected)
            else {
                self.remote_connection_manager.save_failed(format!(
                    "Remote connection `{}` no longer exists",
                    selected.as_str()
                ));
                self.rebuild_and_focus_remote_connection_manager();
                return false;
            };
            self.remote_connection_manager.select(index);
        }
        self.rebuild_and_focus_remote_connection_manager();
        true
    }

    pub(super) fn activate_remote_connection_manager_element(&mut self, id: ElementId) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        if let Some(index) = remote_connection_manager_item_index(
            id,
            self.remote_connection_manager.connections().len(),
        ) {
            if self.remote_connection_manager.select(index) {
                self.remote_connection_manager_changed();
            }
            return true;
        }
        match id {
            REMOTE_CONNECTION_MANAGER_CLOSE => {
                self.dismiss_remote_connection_manager();
            }
            REMOTE_CONNECTION_MANAGER_NEW => {
                if self.remote_connection_manager.start_new() {
                    self.rebuild_and_focus_remote_connection_manager_field(
                        RemoteConnectionManagerField::Name,
                    );
                } else {
                    self.remote_connection_manager_changed();
                }
            }
            REMOTE_CONNECTION_MANAGER_SAVE => self.save_remote_connection_manager(),
            REMOTE_CONNECTION_MANAGER_DELETE => self.delete_remote_connection_manager(),
            REMOTE_CONNECTION_MANAGER_CONNECT => self.connect_remote_connection_manager(),
            REMOTE_CONNECTION_MANAGER
            | REMOTE_CONNECTION_MANAGER_NAME
            | REMOTE_CONNECTION_MANAGER_HOST
            | REMOTE_CONNECTION_MANAGER_DIRECTORY => {}
            _ => return false,
        }
        true
    }

    pub(super) fn route_remote_connection_manager_pointer_move(&mut self, point: Point) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        if self.remote_connection_manager.is_settings() {
            return false;
        }
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .pointer_moved(point, presentation.interaction_frame())
            })
            .unwrap_or_default();
        self.update_cursor();
        self.apply_dispatch_outcome(outcome);
        true
    }

    pub(super) fn route_remote_connection_manager_button(
        &mut self,
        state: ElementState,
        button: MouseButton,
    ) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        if self.remote_connection_manager.is_settings() {
            return false;
        }
        if button != MouseButton::Left {
            return true;
        }
        let target = self
            .cursor_position
            .zip(self.presentation.as_ref())
            .and_then(|(point, presentation)| presentation.interaction_frame().target_at(point));
        match state {
            ElementState::Pressed
                if target.is_some_and(|id| {
                    is_remote_connection_manager_element(
                        id,
                        self.remote_connection_manager.connections().len(),
                    )
                }) =>
            {
                self.primary_button_changed(state);
            }
            ElementState::Pressed => {
                self.dismiss_remote_connection_manager();
            }
            ElementState::Released => self.primary_button_changed(state),
        }
        true
    }

    pub(super) fn route_remote_connection_manager_wheel(
        &mut self,
        delta: MouseScrollDelta,
    ) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        let embedded = self.remote_connection_manager.is_settings();
        let Some(presentation) = self.presentation.as_ref() else {
            return !embedded;
        };
        let Some(viewport) = presentation.remote_connection_manager_list_viewport else {
            return !embedded;
        };
        if !self
            .cursor_position
            .is_some_and(|point| viewport.contains(point))
        {
            return !embedded;
        }
        let Some(metrics) = presentation.remote_connection_manager_scroll_metrics else {
            return !embedded;
        };
        if self
            .remote_connection_manager
            .apply_scroll(remote_connection_manager_scroll_command(delta), metrics)
        {
            if embedded {
                self.rebuild_presentation_on_next_redraw();
            } else {
                self.rebuild_overlay_on_next_redraw();
            }
        }
        true
    }

    pub(super) fn route_remote_connection_manager_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        let embedded = self.remote_connection_manager.is_settings();
        let manager_has_focus = self.ui_dispatch.focused().is_some_and(|id| {
            is_remote_connection_manager_element(
                id,
                self.remote_connection_manager.connections().len(),
            )
        });
        if embedded && !manager_has_focus {
            return false;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            if embedded {
                return false;
            }
            self.dismiss_remote_connection_manager();
            return true;
        }
        if let Some(field) = self.focused_remote_connection_manager_field() {
            if self.route_remote_connection_manager_clipboard(event, field) {
                return true;
            }
            if event.logical_key == Key::Named(NamedKey::Enter) {
                self.save_remote_connection_manager();
                return true;
            }
            if event.logical_key == Key::Named(NamedKey::Tab) {
                self.navigate_remote_connection_manager(if self.modifiers.shift_key() {
                    FocusDirection::Previous
                } else {
                    FocusDirection::Next
                });
                return true;
            }
            if let Some(command) = text_input_command(event, self.modifiers) {
                self.remote_connection_manager.apply(field, command);
                self.remote_connection_manager_changed();
            }
            return true;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return true;
        };
        let frame = presentation.interaction_frame();
        let outcome = match &event.logical_key {
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
            Key::Named(NamedKey::Tab) => self.ui_dispatch.focus_within_group(
                frame,
                if self.modifiers.shift_key() {
                    FocusDirection::Previous
                } else {
                    FocusDirection::Next
                },
                NavigationAxis::Vertical,
            ),
            Key::Named(NamedKey::Enter) => self.ui_dispatch.activate_focused(frame),
            Key::Character(text) if text == " " => self.ui_dispatch.activate_focused(frame),
            _ => DispatchOutcome::default(),
        };
        self.apply_remote_connection_manager_navigation(outcome);
        true
    }

    pub(super) fn dismiss_remote_connection_manager(&mut self) -> bool {
        if !self.remote_connection_manager.is_open() {
            return false;
        }
        if let Some(launch) = self.remote_connection_launch.take()
            && let Err(error) = launch.cancel()
        {
            eprintln!("{error}");
        }
        let restore_focus = self.remote_connection_manager.dismiss();
        self.rebuild_presentation();
        if let Some(restore_focus) = restore_focus {
            let outcome = self
                .presentation
                .as_ref()
                .map(|presentation| {
                    self.ui_dispatch
                        .focus_element(presentation.interaction_frame(), restore_focus)
                })
                .unwrap_or_default();
            if outcome.invalidation == DispatchInvalidation::Paint {
                self.rebuild_presentation();
            }
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
        true
    }

    fn save_remote_connection_manager(&mut self) {
        let Some(request) = self.remote_connection_manager.save_request() else {
            self.remote_connection_manager_changed();
            return;
        };
        let result = ash_utils_home_dir::find_ash_home()
            .map_err(|error| error.to_string())
            .and_then(|root| {
                let catalog = RemoteConnectionCatalog::from_profile_root(root);
                match request {
                    RemoteConnectionSaveRequest::Create(entry) => {
                        catalog.save(entry, RemoteConnectionSaveMode::Create)
                    }
                    RemoteConnectionSaveRequest::Update { original, entry } => {
                        catalog.update(&original, entry)
                    }
                }
                .map_err(|error| error.to_string())
            });
        match result {
            Ok(entry) => self.remote_connection_manager.save_succeeded(entry),
            Err(error) => self
                .remote_connection_manager
                .save_failed(error.to_string()),
        }
        self.remote_connection_manager_changed();
    }

    fn delete_remote_connection_manager(&mut self) {
        let Some(name) = self.remote_connection_manager.delete_request() else {
            self.remote_connection_manager_changed();
            return;
        };
        match ash_utils_home_dir::find_ash_home()
            .map_err(|error| error.to_string())
            .and_then(|root| {
                RemoteConnectionCatalog::from_profile_root(root)
                    .remove(&name)
                    .map_err(|error| error.to_string())
            }) {
            Ok(Some(_)) => self.remote_connection_manager.delete_succeeded(&name),
            Ok(None) => self.remote_connection_manager.save_failed(format!(
                "Remote connection `{}` no longer exists",
                name.as_str()
            )),
            Err(error) => self
                .remote_connection_manager
                .save_failed(error.to_string()),
        }
        self.remote_connection_manager_changed();
    }

    fn focused_remote_connection_manager_field(&self) -> Option<RemoteConnectionManagerField> {
        [
            RemoteConnectionManagerField::Name,
            RemoteConnectionManagerField::Host,
            RemoteConnectionManagerField::Directory,
        ]
        .into_iter()
        .find(|field| self.ui_dispatch.is_focused(field.element_id()))
    }

    fn route_remote_connection_manager_clipboard(
        &mut self,
        event: &KeyEvent,
        field: RemoteConnectionManagerField,
    ) -> bool {
        let shortcut = self.modifiers.control_key() || self.modifiers.super_key();
        let Key::Character(text) = &event.logical_key else {
            return false;
        };
        if shortcut && text.eq_ignore_ascii_case("c") {
            if let Some(text) = self.remote_connection_manager.selected_text(field)
                && let Err(error) = write_clipboard_text(&self.clipboard, text.into())
            {
                eprintln!("could not copy Remote connection field: {error}");
            }
            return true;
        }
        if shortcut && text.eq_ignore_ascii_case("v") {
            match read_clipboard_text(&self.clipboard) {
                Ok(text) => self
                    .remote_connection_manager
                    .apply(field, TextInputCommand::Insert(text)),
                Err(error) => eprintln!("could not paste Remote connection field: {error}"),
            }
            self.remote_connection_manager_changed();
            return true;
        }
        false
    }

    fn navigate_remote_connection_manager(&mut self, direction: FocusDirection) {
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch.focus_within_group(
                    presentation.interaction_frame(),
                    direction,
                    NavigationAxis::Vertical,
                )
            })
            .unwrap_or_default();
        self.apply_remote_connection_manager_navigation(outcome);
    }

    fn apply_remote_connection_manager_navigation(&mut self, outcome: DispatchOutcome) {
        self.apply_dispatch_outcome(outcome);
        let Some(index) = self.ui_dispatch.focused().and_then(|id| {
            remote_connection_manager_item_index(
                id,
                self.remote_connection_manager.connections().len(),
            )
        }) else {
            self.sync_input_focus();
            return;
        };
        let Some(metrics) = self
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.remote_connection_manager_scroll_metrics)
        else {
            return;
        };
        if self
            .remote_connection_manager
            .ensure_item_visible(index, metrics)
        {
            self.rebuild_presentation();
            self.request_redraw();
        }
    }

    fn rebuild_and_focus_remote_connection_manager(&mut self) {
        let focus = self
            .remote_connection_manager
            .selected_index()
            .map(remote_connection_manager_item_id)
            .unwrap_or(REMOTE_CONNECTION_MANAGER_NAME);
        self.rebuild_and_focus_remote_connection_manager_element(focus);
    }

    fn rebuild_and_focus_remote_connection_manager_field(
        &mut self,
        field: RemoteConnectionManagerField,
    ) {
        self.rebuild_and_focus_remote_connection_manager_element(field.element_id());
    }

    fn rebuild_and_focus_remote_connection_manager_element(&mut self, focus: ElementId) {
        self.rebuild_presentation();
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .focus_element(presentation.interaction_frame(), focus)
            })
            .unwrap_or_default();
        if outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
    }

    pub(super) fn remote_connection_manager_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }
}

#[cfg(test)]
#[path = "remote_connection_manager_input_tests.rs"]
mod tests;
