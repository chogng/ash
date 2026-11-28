//! Shared internal process roles for executables that embed Ash helper capabilities.

use std::ffi::OsString;

/// Dispatches an internal process role before normal product argument parsing.
/// `None` leaves ordinary arguments to the product; a recognized role returns its final result.
/// Arguments exclude the executable name. Malformed helper invocations fail before execution.
pub fn dispatch(arguments: impl IntoIterator<Item = OsString>) -> Option<Result<(), String>> {
    let mut arguments = arguments.into_iter();
    let role = arguments.next();
    #[cfg(windows)]
    if role.as_deref()
        == Some(std::ffi::OsStr::new(
            mxc_sdk::v1::PSEC_PTY_EXECUTOR_ARGUMENT,
        ))
    {
        return Some(
            mxc_sdk::v1::run_psec_pty_executor(role.into_iter().chain(arguments))
                .map_err(|error| error.to_string()),
        );
    }
    if role.as_deref() == Some(std::ffi::OsStr::new(ash_pdf::WORKER_ARGUMENT)) {
        if arguments.next().is_some() {
            return Some(Err("PDF worker accepts no arguments".into()));
        }
        return Some(ash_pdf::run_worker());
    }
    #[cfg(unix)]
    {
        if role.as_deref()
            == Some(std::ffi::OsStr::new(
                ash_utils_process::process_guard::PROCESS_GUARD_ARGUMENT,
            ))
        {
            if arguments.next().is_some() {
                return Some(Err("Process session guard accepts no arguments".into()));
            }
            return Some(
                ash_utils_process::process_guard::run_process_guard()
                    .map_err(|error| error.to_string()),
            );
        }
        if let Err(error) = ash_utils_process::process_guard::enable_process_guard() {
            return Some(Err(error.to_string()));
        }
    }
    #[cfg(target_os = "macos")]
    if role.as_deref()
        == Some(std::ffi::OsStr::new(
            ash_file_watcher::NATIVE_WATCHER_ARGUMENT,
        ))
    {
        if arguments.next().is_some() {
            return Some(Err("Native file watcher helper accepts no arguments".into()));
        }
        return Some(ash_file_watcher::run_native_watcher());
    }
    #[cfg(target_os = "macos")]
    if role.as_deref()
        == Some(std::ffi::OsStr::new(
            ash_file_watcher::POLLING_WATCHER_ARGUMENT,
        ))
    {
        if arguments.next().is_some() {
            return Some(Err(
                "Polling file watcher helper accepts no arguments".into()
            ));
        }
        return Some(ash_file_watcher::run_polling_watcher());
    }
    if role.as_deref()
        == Some(std::ffi::OsStr::new(
            ash_file_system::ELEVATED_FILE_WRITE_ARGUMENT,
        ))
    {
        return Some(
            ash_file_system::run_elevated_file_helper(arguments).map_err(|error| error.to_string()),
        );
    }
    None
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
