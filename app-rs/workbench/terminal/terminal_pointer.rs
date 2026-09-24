use anyhow::Result;
use ash_terminal::TerminalMousePosition;
use zui::input::{ElementState, ModifiersState, MouseButton, MouseScrollDelta};

pub(crate) use ash_terminal_runtime::{PointerInput, TerminalPointer};

use crate::PaneGroupId as PaneId;
use crate::WorkbenchApplication;
use crate::terminal_session::TerminalSession;
use crate::{terminal_mouse_position_for_viewport, terminal_pane_mouse_position_for_viewport};

pub(crate) trait TerminalPointerRouting {
    fn route_moved(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        modifiers: ModifiersState,
    ) -> Result<bool>;

    fn route_button(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        button: MouseButton,
        state: ElementState,
        modifiers: ModifiersState,
    ) -> Result<bool>;

    fn route_wheel(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        delta: MouseScrollDelta,
        modifiers: ModifiersState,
    ) -> Result<bool>;
}

impl TerminalPointerRouting for TerminalPointer {
    fn route_moved(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        modifiers: ModifiersState,
    ) -> Result<bool> {
        let input = self.moved(terminal.core(), position, modifiers);
        send_pointer_input(terminal, input)
    }

    fn route_button(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        button: MouseButton,
        state: ElementState,
        modifiers: ModifiersState,
    ) -> Result<bool> {
        let input = self.button_changed(terminal.core(), position, button, state, modifiers);
        send_pointer_input(terminal, input)
    }

    fn route_wheel(
        &mut self,
        terminal: &mut TerminalSession,
        position: Option<TerminalMousePosition>,
        delta: MouseScrollDelta,
        modifiers: ModifiersState,
    ) -> Result<bool> {
        let input = self.wheel(terminal.core(), position, delta, modifiers);
        send_pointer_input(terminal, input)
    }
}

impl WorkbenchApplication {
    pub(crate) fn terminal_pane_hit(
        &self,
        point: zui::ui::Point,
    ) -> Option<(PaneId, TerminalMousePosition)> {
        let tab_key = self.workbench.workbench().sidebar_part().active_tab_key()?;
        let layout = self.workbench.workbench().pane_part(tab_key)?;
        terminal_pane_mouse_position_for_viewport(
            self.logical_viewport(),
            self.active_screen(),
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
            layout,
            point,
        )
    }

    pub(crate) fn activate_terminal_pane_at(&mut self, point: zui::ui::Point) -> bool {
        let Some((pane, _position)) = self.terminal_pane_hit(point) else {
            return false;
        };
        let Some(tab_key) = self
            .workbench
            .workbench()
            .sidebar_part()
            .active_tab_key()
            .cloned()
        else {
            return false;
        };
        self.activate_pane_context(tab_key, pane)
    }

    pub(crate) fn terminal_mouse_position(
        &self,
        point: zui::ui::Point,
    ) -> Option<TerminalMousePosition> {
        if !self.main_surface.is_terminal() {
            return None;
        }
        if let Some((pane, position)) = self.terminal_pane_hit(point) {
            let tab = self.workbench.workbench().sidebar_part().active_tab_key()?;
            return self
                .terminal_pane_views
                .active()
                .is_some_and(|key| key.tab() == tab && key.pane() == pane)
                .then_some(position);
        }
        terminal_mouse_position_for_viewport(
            self.logical_viewport(),
            self.active_screen(),
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
            point,
        )
    }

    pub(super) fn route_terminal_pointer_move(
        &mut self,
        position: Option<TerminalMousePosition>,
    ) -> bool {
        let modifiers = self.modifiers;
        let mut terminal_pointer = std::mem::take(&mut self.terminal_view_mut().pointer);
        let result = self
            .active_terminal_mut()
            .map(|terminal| terminal_pointer.route_moved(terminal, position, modifiers));
        self.terminal_view_mut().pointer = terminal_pointer;
        let Some(result) = result else {
            return false;
        };
        match result {
            Ok(captured) => captured,
            Err(error) => {
                eprintln!("could not send terminal pointer input: {error}");
                true
            }
        }
    }

    pub(super) fn route_terminal_pointer_button(
        &mut self,
        position: Option<TerminalMousePosition>,
        button: MouseButton,
        state: ElementState,
    ) -> bool {
        let modifiers = self.modifiers;
        let mut terminal_pointer = std::mem::take(&mut self.terminal_view_mut().pointer);
        let result = self.active_terminal_mut().map(|terminal| {
            terminal_pointer.route_button(terminal, position, button, state, modifiers)
        });
        self.terminal_view_mut().pointer = terminal_pointer;
        let Some(result) = result else {
            return false;
        };
        match result {
            Ok(captured) => captured,
            Err(error) => {
                eprintln!("could not send terminal pointer input: {error}");
                true
            }
        }
    }
}

fn send_pointer_input(terminal: &mut TerminalSession, input: PointerInput) -> Result<bool> {
    let PointerInput::Consumed(input) = input else {
        return Ok(false);
    };
    terminal.send_input(input)?;
    Ok(true)
}
