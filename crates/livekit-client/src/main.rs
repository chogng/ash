mod host;

fn main() {
    if process_hardening::initialize().is_err() {
        std::process::exit(1);
    }
    let _lease = std::env::current_exe()
        .and_then(ash_package_store::acquire_package_lease_for_executable)
        .unwrap_or_else(|_| std::process::exit(1));
    let provider = host::RoomHost::new().unwrap_or_else(|_| std::process::exit(1));
    let options = external_ext_sdk::RuntimeOptions {
        protocol: external_ext_sdk::ProtocolLimits {
            maximum_frame_bytes: livekit_client::protocol::MAX_FRAME_BYTES,
            maximum_payload_bytes: livekit_client::protocol::MAX_PAYLOAD_BYTES,
            ..external_ext_sdk::ProtocolLimits::default()
        },
        maximum_in_flight_requests: 16,
    };
    if external_ext_sdk::run_stdio_with_options(provider, options).is_err() {
        eprintln!("LiveKit client stopped");
        std::process::exit(1);
    }
}
