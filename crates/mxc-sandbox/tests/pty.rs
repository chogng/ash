use libtest_mimic::Arguments;
#[cfg(windows)]
use test_binary_support::TestBinary;

#[cfg(unix)]
#[path = "pty/cases.rs"]
mod cases;

#[cfg(windows)]
#[path = "pty/windows.rs"]
mod windows_cases;

#[cfg(windows)]
fn helper() -> TestBinary {
    TestBinary::role(mxc_sandbox::PTY_HELPER_ARGUMENT).unwrap()
}

fn main() {
    #[cfg(windows)]
    helper().dispatch(mxc_sandbox::run_pty_helper);
    #[cfg(unix)]
    let tests = cases::trials();
    #[cfg(windows)]
    let tests = windows_cases::trials();
    libtest_mimic::run(&Arguments::from_args(), tests).exit();
}
