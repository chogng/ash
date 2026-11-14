// This pipe-only Desktop helper never needs a console. A console-subsystem
// executable creates a hidden conhost even when Electron sets windowsHide.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args_os().len() != 1 {
        eprintln!("host logs helper accepts no arguments");
        return ExitCode::FAILURE;
    }
    if let Err(error) = process_hardening::initialize() {
        eprintln!("host log process hardening failed: {error}");
        return ExitCode::FAILURE;
    }
    match ash_host_logs::run_stdio() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("host log persistence failed: {error}");
            ExitCode::FAILURE
        }
    }
}
