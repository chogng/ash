fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        std::process::exit(1);
    }
    if let Some(result) = arg0::dispatch(std::env::args_os().skip(1)) {
        if let Err(error) = result {
            eprintln!("ash: {error}");
            std::process::exit(1);
        }
        return;
    }
    std::process::exit(ash_cli::run(std::env::args_os()));
}
