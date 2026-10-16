fn main() {
    let options = external_ext_sdk::RuntimeOptions {
        protocol: external_ext_sdk::ProtocolLimits {
            maximum_frame_bytes: 32 * 1024 * 1024,
            maximum_payload_bytes: 24 * 1024 * 1024,
            ..Default::default()
        },
        ..Default::default()
    };
    if external_ext_sdk::run_stdio_with_options(
        ash_markdown_language_features::MarkdownExtension,
        options,
    )
    .is_err()
    {
        std::process::exit(1);
    }
}
