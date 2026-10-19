fn main() {
    if external_ext_sdk::run_stdio(ash_code_editor::CodeExtension).is_err() {
        std::process::exit(1);
    }
}
