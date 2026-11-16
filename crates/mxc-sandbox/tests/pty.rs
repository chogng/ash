use libtest_mimic::Arguments;

#[cfg(unix)]
#[path = "pty/cases.rs"]
mod cases;

#[cfg(windows)]
#[path = "pty/windows.rs"]
mod windows_cases;

fn main() {
    #[cfg(unix)]
    let tests = cases::trials();
    #[cfg(windows)]
    let tests = windows_cases::trials();
    libtest_mimic::run(&Arguments::from_args(), tests).exit();
}
