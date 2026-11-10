#![deny(unsafe_code)]

use std::process::ExitCode;

#[cfg(any(windows, test))]
mod association;
#[cfg(windows)]
mod windows;

fn main() -> ExitCode {
    #[cfg(windows)]
    match windows::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
    #[cfg(not(windows))]
    ExitCode::FAILURE
}
