fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        std::process::exit(1);
    }
    let _package_lease = match std::env::current_exe()
        .and_then(ash_package_store::acquire_package_lease_for_executable)
    {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("ash: could not lease its package: {error}");
            std::process::exit(1);
        }
    };
    if let Some(result) = arg0::dispatch(std::env::args_os().skip(1)) {
        if let Err(error) = result {
            eprintln!("ash: {error}");
            std::process::exit(1);
        }
        return;
    }
    std::process::exit(ash_cli::run(std::env::args_os()));
}
