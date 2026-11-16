pub mod pipe;
mod process;
pub mod pty;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
#[cfg(unix)]
mod unix_io;
#[cfg(windows)]
mod win;
#[cfg(all(test, windows))]
mod windows_console_tests;
#[cfg(windows)]
mod windows_input;

/// Handle for interacting with a spawned process (PTY or pipe).
pub use process::ProcessHandle;
/// Process signal supported by spawned-process handles.
pub use process::ProcessSignal;
/// Bundle of process handles plus split output and exit receivers returned by spawn helpers.
pub use process::SpawnedProcess;
/// Terminal size in character cells used for PTY spawn and resize operations.
pub use process::TerminalSize;
pub use pty::PtyArguments;
/// Report whether ConPTY is available on this platform (Windows only).
pub use pty::conpty_supported;
/// Spawn a process attached to a PTY for interactive use.
pub use pty::spawn_process as spawn_pty_process;
#[cfg(windows)]
pub use windows_input::WindowsTtyInputNormalizer;

#[cfg(windows)]
pub use pipe::CancellablePipeReader;
#[cfg(windows)]
pub use win::PreparedConPty;
