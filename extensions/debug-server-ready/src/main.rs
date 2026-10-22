fn main() {
    if external_ext_sdk::run_stdio(ash_debug_server_ready::Extension::default()).is_err() {
        std::process::exit(1);
    }
}
