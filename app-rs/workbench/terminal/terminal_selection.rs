use ash_terminal::TerminalMousePosition;
use zui::input::ElementState;
use zui::services::{ClipboardError, ClipboardHandle};

use crate::WorkbenchApplication;
use crate::terminal_history::visible_text_lines;

impl WorkbenchApplication {
    pub(super) fn route_terminal_selection_move(
        &mut self,
        position: Option<TerminalMousePosition>,
    ) -> bool {
        if !self.terminal_view_mut().selection.moved(position) {
            return false;
        }
        self.rebuild_presentation();
        self.request_redraw();
        true
    }

    pub(super) fn route_terminal_selection_button(
        &mut self,
        position: Option<TerminalMousePosition>,
        state: ElementState,
    ) -> bool {
        let active_screen = self
            .active_terminal()
            .map(|terminal| terminal.core().active_screen())
            .unwrap_or_default();
        let previous = self.terminal_view().selection.range();
        let captured =
            self.terminal_view_mut()
                .selection
                .button_changed(active_screen, position, state);
        if captured || previous != self.terminal_view().selection.range() {
            self.rebuild_presentation();
            self.request_redraw();
        }
        captured
    }

    pub(super) fn copy_terminal_selection(&mut self) -> bool {
        let Some(terminal) = self.active_terminal() else {
            return false;
        };
        let lines = visible_text_lines(
            terminal.core(),
            terminal.core().grid().size().rows() as usize,
            self.terminal_view().scroll.offset(),
        );
        let Some(text) = self.terminal_view().selection.selected_text(&lines) else {
            return false;
        };
        if let Err(error) = write_clipboard_text(&self.clipboard, text) {
            eprintln!("could not copy terminal selection: {error}");
        }
        true
    }
}

pub(crate) fn write_clipboard_text(
    clipboard: &ClipboardHandle,
    text: String,
) -> Result<(), ClipboardError> {
    clipboard.write_text(text)
}

pub(crate) fn read_clipboard_text(clipboard: &ClipboardHandle) -> Result<String, ClipboardError> {
    clipboard.read_text()
}
