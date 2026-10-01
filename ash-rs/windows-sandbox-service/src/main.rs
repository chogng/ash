//! SCM host for explicitly approved Windows account provisioning.
#[cfg(windows)]
extern crate windows_sys_061 as windows_sys;

#[cfg(windows)]
mod installation;
#[cfg(windows)]
mod service;

fn main() {
    #[cfg(windows)]
    let result = {
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        if arguments.is_empty() {
            service::run()
        } else {
            installation::run(&arguments)
        }
    };
    #[cfg(not(windows))]
    let result: Result<(), String> = Err("Windows sandbox service requires Windows".into());
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
