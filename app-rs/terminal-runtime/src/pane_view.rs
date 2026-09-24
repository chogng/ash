use crate::{TerminalPointer, TerminalScroll, TerminalSelection};

/// Complete retained UI state for one terminal Pane input.
#[derive(Default)]
pub struct TerminalPaneViewState {
    pub scroll: TerminalScroll,
    pub pointer: TerminalPointer,
    pub selection: TerminalSelection,
}
