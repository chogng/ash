//! Command construction for background processes that must not open a Windows console window.
//! Callers own environment, stdio, and process lifetime. Interactive, detached, PTY,
//! and sandbox launches select their console policy in their owning modules.

use std::ffi::OsStr;
use std::process::Command;

/// Construct a background command, suppressing console window creation on Windows.
///
/// Convert with `tokio::process::Command::from` for asynchronous execution.
/// Subsequent Windows `creation_flags` calls replace the flags and must retain
/// `CREATE_NO_WINDOW` when the process should remain windowless.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new(program);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }
    #[cfg(not(windows))]
    Command::new(program)
}

#[cfg(test)]
mod background_command_tests;
