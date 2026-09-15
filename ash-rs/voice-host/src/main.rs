fn main() {
    if process_hardening::initialize().is_err() {
        std::process::exit(2);
    }
    if voice_host::server::run().is_err() {
        eprintln!("audio host stopped after a protocol or device failure");
        std::process::exit(1);
    }
}
