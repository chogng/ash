#[cfg(windows)]
mod appwindow;
#[cfg(windows)]
mod appwindow_bindings;
#[cfg(windows)]
mod composition;
#[cfg(windows)]
mod windows_host;

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    windows_host::run()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Ash native Desktop currently requires Windows.");
    std::process::exit(1);
}
