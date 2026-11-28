use libtest_mimic::Arguments;

#[cfg(unix)]
#[path = "pty/cases.rs"]
mod cases;

#[cfg(windows)]
#[path = "pty/windows.rs"]
mod windows_cases;

fn main() {
    #[cfg(windows)]
    {
        let mut args = std::env::args_os().skip(1).peekable();
        if args
            .peek()
            .is_some_and(|argument| argument == mxc_sdk::v1::PSEC_PTY_EXECUTOR_ARGUMENT)
        {
            std::process::exit(i32::from(mxc_sdk::v1::run_psec_pty_executor(args).is_err()));
        }
    }
    #[cfg(unix)]
    let tests = cases::trials();
    #[cfg(windows)]
    let tests = windows_cases::trials();
    libtest_mimic::run(&Arguments::from_args(), tests).exit();
}
