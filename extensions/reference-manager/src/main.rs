fn main() {
    if external_ext_sdk::run_stdio(ash_reference_manager::ReferenceManagerExtension).is_err() {
        std::process::exit(1);
    }
}
