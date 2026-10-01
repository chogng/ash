fn main() {
    if process_hardening::initialize().is_err() {
        std::process::exit(2);
    }
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
