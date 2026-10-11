fn main() {
    let options = external_ext_sdk::RuntimeOptions {
        protocol: external_ext_sdk::ProtocolLimits {
            maximum_frame_bytes: ash_app_server_protocol::git_provider::GIT_PROVIDER_PAYLOAD_BYTES
                + 1024 * 1024,
            maximum_payload_bytes:
                ash_app_server_protocol::git_provider::GIT_PROVIDER_PAYLOAD_BYTES,
            ..external_ext_sdk::ProtocolLimits::default()
        },
        ..external_ext_sdk::RuntimeOptions::default()
    };
    if external_ext_sdk::run_stdio_with_options(git_extension::GitExtension::default(), options)
        .is_err()
    {
        eprintln!("Git extension stopped");
        std::process::exit(1);
    }
}
