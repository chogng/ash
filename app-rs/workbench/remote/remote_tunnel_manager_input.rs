use std::time::Instant;

use ash_settings::REMOTE_TUNNEL_ITEM_HEIGHT;
use ash_settings::REMOTE_TUNNEL_MANAGER;
use ash_settings::REMOTE_TUNNEL_MANAGER_CLOSE;
use ash_settings::REMOTE_TUNNEL_OPEN;
use ash_settings::REMOTE_TUNNEL_REMOTE_PORT;
use ash_settings::is_remote_tunnel_manager_element;
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
use zui::ui::NavigationAxis;
use zui::ui::Point;
use zui::ui::TextInputCommand;

use crate::WorkbenchApplication;
use crate::remote_tunnel_process::RemoteTunnelEvent;
use crate::remote_tunnel_process::RemoteTunnelId;
use crate::terminal_input::text_input_command;
use crate::terminal_selection::read_clipboard_text;
use crate::terminal_selection::write_clipboard_text;

const MANAGER_ROWS_PER_WHEEL_STEP: f32 = 3.0;

impl WorkbenchApplication {
    pub(super) fn open_remote_tunnel_manager(&mut self, restore_focus: Option<ElementId>) -> bool {
        let Some(host) = self.remote_tunnel_host.as_ref() else {
            eprintln!("Remote tunnels are available only in a Remote app window");
            return false;
        };
        let host = host.host().as_str().to_owned();
        self.remote_tunnel_manager.open(host, restore_focus);
        self.workbench.dismiss_tab_context_menu();
        self.git_branch_picker.dismiss();
        self.directory_picker.dismiss();
        self.remote_connection_picker.dismiss();
        self.dismiss_remote_connection_manager();
        self.rebuild_and_focus_remote_tunnel_port();
        true
    }

    pub(super) fn activate_remote_tunnel_manager_element(&mut self, id: ElementId) -> bool {
        if !self.remote_tunnel_manager.is_open() {
            return false;
        }
        if let Some(tunnel_id) = self.remote_tunnel_manager.stop_id(id) {
            self.stop_remote_tunnel(tunnel_id);
            return true;
        }
        match id {
            REMOTE_TUNNEL_MANAGER_CLOSE => {
                self.dismiss_remote_tunnel_manager();
            }
            REMOTE_TUNNEL_OPEN => self.start_remote_tunnel(),
            REMOTE_TUNNEL_MANAGER | REMOTE_TUNNEL_REMOTE_PORT => {}
            _ => {
                if !is_remote_tunnel_manager_element(id, self.remote_tunnel_manager.tunnels()) {
                    return false;
                }
            }
        }
        true
    }

    pub(super) fn route_remote_tunnel_manager_pointer_move(&mut self, point: Point) -> bool {
        if !self.remote_tunnel_manager.is_open() {
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

    pub(super) fn route_remote_tunnel_manager_button(
        &mut self,
        state: ElementState,
        button: MouseButton,
    ) -> bool {
        if !self.remote_tunnel_manager.is_open() {
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
                    is_remote_tunnel_manager_element(id, self.remote_tunnel_manager.tunnels())
                }) =>
            {
                self.primary_button_changed(state);
            }
            ElementState::Pressed => {
                self.dismiss_remote_tunnel_manager();
            }
            ElementState::Released => self.primary_button_changed(state),
        }
        true
    }

    pub(super) fn route_remote_tunnel_manager_wheel(&mut self, delta: MouseScrollDelta) -> bool {
        if !self.remote_tunnel_manager.is_open() {
            return false;
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return true;
        };
        let Some(viewport) = presentation.remote_tunnel_manager_list_viewport else {
            return true;
        };
        if !self
            .cursor_position
            .is_some_and(|point| viewport.contains(point))
        {
            return true;
        }
        let Some(metrics) = presentation.remote_tunnel_manager_scroll_metrics else {
            return true;
        };
        if self
            .remote_tunnel_manager
            .apply_scroll(remote_tunnel_manager_scroll_command(delta), metrics)
        {
            self.rebuild_overlay_on_next_redraw();
        }
        true
    }

    pub(super) fn route_remote_tunnel_manager_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.remote_tunnel_manager.is_open() {
            return false;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.dismiss_remote_tunnel_manager();
            return true;
        }
        if self.ui_dispatch.is_focused(REMOTE_TUNNEL_REMOTE_PORT) {
            if self.route_remote_tunnel_clipboard(event) {
                return true;
            }
            if event.logical_key == Key::Named(NamedKey::Enter) {
                self.start_remote_tunnel();
                return true;
            }
            if event.logical_key == Key::Named(NamedKey::Tab) {
                self.navigate_remote_tunnel_manager(if self.modifiers.shift_key() {
                    FocusDirection::Previous
                } else {
                    FocusDirection::Next
                });
                return true;
            }
            if let Some(command) = text_input_command(event, self.modifiers) {
                self.remote_tunnel_manager.apply_remote_port(command);
                self.remote_tunnel_manager_changed();
            }
            return true;
        }
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| match &event.logical_key {
                Key::Named(NamedKey::ArrowUp) => self.ui_dispatch.focus_within_group(
                    presentation.interaction_frame(),
                    FocusDirection::Previous,
                    NavigationAxis::Vertical,
                ),
                Key::Named(NamedKey::ArrowDown) => self.ui_dispatch.focus_within_group(
                    presentation.interaction_frame(),
                    FocusDirection::Next,
                    NavigationAxis::Vertical,
                ),
                Key::Named(NamedKey::Tab) => self.ui_dispatch.focus_within_group(
                    presentation.interaction_frame(),
                    if self.modifiers.shift_key() {
                        FocusDirection::Previous
                    } else {
                        FocusDirection::Next
                    },
                    NavigationAxis::Vertical,
                ),
                Key::Named(NamedKey::Enter) => self
                    .ui_dispatch
                    .activate_focused(presentation.interaction_frame()),
                Key::Character(text) if text == " " => self
                    .ui_dispatch
                    .activate_focused(presentation.interaction_frame()),
                _ => DispatchOutcome::default(),
            })
            .unwrap_or_default();
        self.apply_dispatch_outcome(outcome);
        self.sync_input_focus();
        true
    }

    pub(super) fn dismiss_remote_tunnel_manager(&mut self) -> bool {
        if !self.remote_tunnel_manager.is_open() {
            return false;
        }
        let restore_focus = self.remote_tunnel_manager.dismiss();
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

    pub(super) fn handle_remote_tunnel_event(&mut self, event: RemoteTunnelEvent) {
        let Some(host) = self.remote_tunnel_host.as_mut() else {
            return;
        };
        if !host.handle_event(&event) {
            return;
        }
        if self.remote_tunnel_manager.handle_event(&event) && self.remote_tunnel_manager.is_open() {
            self.remote_tunnel_manager_changed();
        }
    }

    fn start_remote_tunnel(&mut self) {
        let Some(remote_port) = self.remote_tunnel_manager.start_request() else {
            self.remote_tunnel_manager_changed();
            return;
        };
        let result = self
            .remote_tunnel_host
            .as_mut()
            .ok_or_else(|| "Remote SSH transport is unavailable".to_owned())
            .and_then(|host| host.start(remote_port, self.event_proxy.clone()));
        match result {
            Ok(tunnel_id) => self
                .remote_tunnel_manager
                .start_succeeded(tunnel_id, remote_port),
            Err(error) => self.remote_tunnel_manager.start_failed(error),
        }
        self.remote_tunnel_manager_changed();
    }

    fn stop_remote_tunnel(&mut self, tunnel_id: RemoteTunnelId) {
        if !self.remote_tunnel_manager.stop_request(tunnel_id) {
            return;
        }
        if !self
            .remote_tunnel_host
            .as_ref()
            .is_some_and(|host| host.stop(tunnel_id))
        {
            self.remote_tunnel_manager
                .stop_failed(tunnel_id, "SSH tunnel process is no longer available");
        }
        self.remote_tunnel_manager_changed();
    }

    fn route_remote_tunnel_clipboard(&mut self, event: &KeyEvent) -> bool {
        let shortcut = self.modifiers.control_key() || self.modifiers.super_key();
        let Key::Character(text) = &event.logical_key else {
            return false;
        };
        if shortcut && text.eq_ignore_ascii_case("c") {
            if let Some(text) = self.remote_tunnel_manager.selected_remote_port_text()
                && let Err(error) = write_clipboard_text(&self.clipboard, text.into())
            {
                eprintln!("could not copy Remote tunnel port: {error}");
            }
            return true;
        }
        if shortcut && text.eq_ignore_ascii_case("v") {
            match read_clipboard_text(&self.clipboard) {
                Ok(text) => self
                    .remote_tunnel_manager
                    .apply_remote_port(TextInputCommand::Insert(text)),
                Err(error) => eprintln!("could not paste Remote tunnel port: {error}"),
            }
            self.remote_tunnel_manager_changed();
            return true;
        }
        false
    }

    fn navigate_remote_tunnel_manager(&mut self, direction: FocusDirection) {
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
        self.apply_dispatch_outcome(outcome);
        self.sync_input_focus();
    }

    fn rebuild_and_focus_remote_tunnel_port(&mut self) {
        self.rebuild_presentation();
        let outcome = self
            .presentation
            .as_ref()
            .map(|presentation| {
                self.ui_dispatch
                    .focus_element(presentation.interaction_frame(), REMOTE_TUNNEL_REMOTE_PORT)
            })
            .unwrap_or_default();
        if outcome.invalidation == DispatchInvalidation::Paint {
            self.rebuild_presentation();
        }
        self.sync_input_focus();
        self.update_cursor();
        self.request_redraw();
    }

    pub(super) fn remote_tunnel_manager_changed(&mut self) {
        self.caret_blink.activity(Instant::now());
        self.rebuild_presentation();
        self.sync_input_focus();
        self.request_redraw();
    }
}

fn remote_tunnel_manager_scroll_command(delta: MouseScrollDelta) -> ScrollCommand {
    let pixels = match delta {
        MouseScrollDelta::LineDelta(_, vertical) => {
            vertical * MANAGER_ROWS_PER_WHEEL_STEP * REMOTE_TUNNEL_ITEM_HEIGHT
        }
        MouseScrollDelta::PixelDelta(position) => position.y as f32,
    };
    ScrollCommand::ByPixels(ScrollDelta::vertical(-pixels))
}
