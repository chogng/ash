fn main() -> Result<(), external_ext_sdk::RuntimeError> {
    if let Some(code) = git_extension::run_helper() {
        std::process::exit(code);
    }
    external_ext_sdk::run_stdio_with_options(
        git_extension::GitExtension::default(),
        external_ext_sdk::RuntimeOptions {
            protocol: external_ext_sdk::ProtocolLimits {
                maximum_frame_bytes: 32 * 1024 * 1024,
                maximum_payload_bytes: 24 * 1024 * 1024,
                ..Default::default()
            },
            ..Default::default()
        },
    )
}
