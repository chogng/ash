//! Terminal emulation for CLI PTY tests.

mod emulator;
mod grid;
mod screen;

pub use emulator::TerminalCore;
pub use grid::{Cell, CellStyle, GridSize, TerminalColor, TerminalGrid, TerminalLine};
pub use screen::{CursorKeyMode, MouseEncoding, MouseTrackingMode, ScreenBuffer, TerminalModes};
