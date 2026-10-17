use ash_external_ext::ExtensionHostSupervisor;
use std::path::Path;
use std::time::Duration;

#[test]
fn process_registers_only_its_domain_and_preserves_invalid_request_errors() {
    let host = ExtensionHostSupervisor::start_product_resource(
        Path::new(env!("CARGO_BIN_EXE_ash-realtime-voice")),
        "ash.recognition",
        48 * 1024 * 1024,
    )
    .unwrap();
    assert!(
        host.begin_data_channel("livekit.v1", serde_json::json!({}), Duration::from_secs(5))
            .is_err()
    );
    let request = serde_json::json!({"type":"resetRecognizer"});
    let handle = host
        .begin_data_channel("recognition.v1", request, Duration::from_secs(5))
        .unwrap();
    let response = handle.wait().unwrap();
    assert!(
        response.payload.get("Err").is_some(),
        "{:?}",
        response.payload
    );
    host.shutdown().unwrap();
}
