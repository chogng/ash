//! Terminal emulation state and command/output block modeling.

mod block_list;
mod emulator;
mod grid;
mod input;
mod mouse;
mod screen;

pub use block_list::{BlockId, BlockList, BlockStatus, TerminalBlock};
pub use emulator::TerminalCore;
pub use grid::{Cell, CellStyle, GridSize, TerminalColor, TerminalGrid, TerminalLine};
pub use input::{KeyModifiers, TerminalKey};
pub use mouse::{
    MouseModifiers, TerminalMouseButton, TerminalMouseButtonState, TerminalMouseEvent,
    TerminalMouseEventKind, TerminalMousePosition,
};
pub use screen::{CursorKeyMode, MouseEncoding, MouseTrackingMode, ScreenBuffer, TerminalModes};
