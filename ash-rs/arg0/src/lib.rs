//! Shared internal process roles for executables that embed Ash helper capabilities.

use std::ffi::OsString;

/// Dispatches an internal process role before normal product argument parsing.
/// `None` leaves ordinary arguments to the product; a recognized role returns its final result.
/// Arguments exclude the executable name. Malformed helper invocations fail before execution.
pub fn dispatch(arguments: impl IntoIterator<Item = OsString>) -> Option<Result<(), String>> {
    let mut arguments = arguments.into_iter();
    let role = arguments.next();
    if role.as_deref() == Some(std::ffi::OsStr::new(mxc_sandbox::PTY_HELPER_ARGUMENT)) {
        if arguments.next().is_some() {
            return Some(Err("PTY helper accepts no arguments".into()));
        }
        return Some(mxc_sandbox::run_pty_helper().map(|code| std::process::exit(code)));
    }
    None
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
