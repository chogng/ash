use std::process::ExitCode;

fn main() -> ExitCode {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        std::process::exit(1);
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
    if let Some(result) = arg0::dispatch(std::env::args_os().skip(1)) {
        return match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        };
    }
    match ash_remote_server::run_from_environment_with_product_services(
        std::env::args().skip(1),
        ash_install_context::discovered_product_services_path(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ash-remote-server: {error}");
            ExitCode::FAILURE
        }
    }
}
