#![deny(unsafe_code)]

#[cfg(windows)]
#[allow(unsafe_code)]
mod native;

#[cfg(windows)]
fn main() {
    if external_ext_sdk::run_stdio(native::ComputerUse::default()).is_err() {
        eprintln!("Computer Use provider stopped");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Computer Use requires Windows");
    std::process::exit(1);
}
