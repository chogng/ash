use std::process::ExitCode;

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
    let result = match arg0::dispatch(std::env::args_os().skip(1)) {
        Some(result) => result,
        None => ash_app_server::run(std::env::args().skip(1)),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ash-app-server: {error}");
            ExitCode::FAILURE
        }
    }
}
