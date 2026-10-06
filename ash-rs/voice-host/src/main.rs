fn main() {
    if process_hardening::initialize().is_err() {
        std::process::exit(2);
    }
    let _package_lease = match std::env::current_exe()
        .and_then(ash_package_store::acquire_package_lease_for_executable)
    {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("audio host could not lease its package: {error}");
            std::process::exit(1);
        }
    };
    if std::env::args().nth(1).as_deref() == Some("--list-input-devices") {
        match voice_host::server::input_devices() {
            Ok(devices) => {
                if serde_json::to_writer(std::io::stdout().lock(), &devices).is_err() {
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if voice_host::server::run().is_err() {
        eprintln!("audio host stopped after a protocol or device failure");
        std::process::exit(1);
    }
}
