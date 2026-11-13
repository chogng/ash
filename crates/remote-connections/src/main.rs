use std::process::ExitCode;

mod proxy_command;

fn main() -> ExitCode {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        return ExitCode::FAILURE;
    }
    let _package_lease = match std::env::current_exe()
        .and_then(ash_package_store::acquire_package_lease_for_executable)
    {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("could not lease the running package: {error}");
            return ExitCode::FAILURE;
        }
    };
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let result = match arguments.split_first() {
        Some((command, options)) if command == "proxy-command" => proxy_command::run(options),
        _ => ash_remote_connections::run_command(arguments),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ash-remote: {error}");
            ExitCode::FAILURE
        }
    }
}
