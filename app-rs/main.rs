fn main() -> std::process::ExitCode {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        std::process::exit(1);
    }

    ash_workbench::run()
}
