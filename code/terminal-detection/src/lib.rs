//! Detection and interpretation of the terminal hosting the current process.

mod appearance;
mod host;

pub use appearance::BackgroundAppearance;
pub use appearance::BackgroundDetection;
pub use appearance::BackgroundSource;
pub use appearance::ColorLevel;
pub use appearance::TerminalRgb;
pub use appearance::resolve_background;
pub use host::HostTerminal;
pub use host::TerminalKind;
pub use host::TerminalMultiplexer;
pub use host::detect_host_terminal;
