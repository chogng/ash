fn main() {
    if external_ext_sdk::run_stdio(ash_markdown_math::MathExtension).is_err() {
        std::process::exit(1);
    }
}
