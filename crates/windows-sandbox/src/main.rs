fn main() {
    if let Err(error) = windows_sandbox::run(std::env::args_os().skip(1)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
