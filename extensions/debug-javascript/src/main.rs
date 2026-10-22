fn main() {
    if std::env::args().nth(1).as_deref() == Some("--auto-attach") {
        ash_debug_javascript::auto_attach_helper();
        return;
    }
    if external_ext_sdk::run_stdio(ash_debug_javascript::Extension::default()).is_err() {
        std::process::exit(1);
    }
}
