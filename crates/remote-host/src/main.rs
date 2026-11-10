use std::process::ExitCode;

mod forward;

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
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = if let [command, rest @ ..] = args.as_slice()
        && command == "forward"
    {
        forward::run(rest)
    } else {
        ash_remote_host::run_hosted_tunnel(args).map_err(|error| error.to_string())
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ash-remote-host: {error}");
            ExitCode::FAILURE
        }
    }
}
