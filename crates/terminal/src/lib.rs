//! Terminal emulation and command output rendering.

mod command_output;
mod emulator;
mod grid;
mod screen;

pub use command_output::resolve_command_output;
pub use emulator::TerminalCore;
pub use grid::{Cell, CellStyle, GridSize, TerminalColor, TerminalGrid, TerminalLine};
pub use screen::{CursorKeyMode, MouseEncoding, MouseTrackingMode, ScreenBuffer, TerminalModes};
