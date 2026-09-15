//! Shared internal process roles for executables that embed Ash helper capabilities.

use ash_fast_regex_search::FastRegexWorkerCommand;
use std::ffi::OsString;
use std::path::PathBuf;

const FAST_REGEX_WORKER: &str = "--ash-fast-regex-worker";

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
    if role.as_deref() != Some(std::ffi::OsStr::new(FAST_REGEX_WORKER)) {
        return None;
    }
    if arguments.next().is_some() {
        return Some(Err(format!("{FAST_REGEX_WORKER} accepts no arguments")));
    }
    Some(ash_fast_regex_search::serve_worker_from_environment().map_err(|error| error.to_string()))
}

/// Builds a worker command for an executable whose entrypoint calls [`dispatch`].
/// The caller supplies the actual host executable, including in process integration tests.
pub fn fast_regex_worker_command(executable: impl Into<PathBuf>) -> FastRegexWorkerCommand {
    FastRegexWorkerCommand::new(executable, [FAST_REGEX_WORKER])
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
