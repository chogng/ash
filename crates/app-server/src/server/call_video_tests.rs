use super::*;
use std::time::Instant;

fn frame(id: &str, value: u8) -> ScreenFrame {
    ScreenFrame {
        participant_id: "speaker".into(),
        track_id: id.into(),
        received_at: Instant::now(),
        width: 32,
        height: 16,
        rotation: 90,
        rgba: vec![value; 32 * 16 * 4],
    }
}

#[test]
fn slow_readers_get_only_latest_frames_and_removed_tracks_release_pixels() {
    let mut screens = Screens::default();
    screens.push(frame("one", 1));
    screens.push(frame("one", 2));
    screens.push(frame("two", 3));
    screens.remove("two");
    let (tracks, mut frames) = screens.take();
    assert_eq!(tracks, ["one"]);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames.pop().unwrap().rgba[0], 2);
    assert!(screens.take().1.is_empty());
    screens.remove_participant("speaker");
    assert!(screens.take().0.is_empty());
}

#[test]
fn transport_frames_are_valid_jpeg_with_rotation_applied() {
    let encoded = encode(frame("one", 120)).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.jpeg)
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (16, 32));
}

#[test]
fn screen_calls_require_product_authority_before_accessing_devices_or_sessions() {
    use crate::local::ProviderModelService;
    use crate::server::AppServer;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_model_provider::EchoModel;
    use std::sync::Arc;
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    );
    let mut connection = server.connection();
    let initialized: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection,
        &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"screen-test","version":"1"},"capabilities":{}}}).to_string())).unwrap();
    assert!(initialized.get("result").is_some());
    for (index, (method, params)) in [
        (
            "call/start",
            serde_json::json!({"resourceId":"another-window", "operationId":"start", "deviceId":"device", "deployment":{"type":"local"}}),
        ),
        (
            "call/screenSources",
            serde_json::json!({"resourceId":"another-window"}),
        ),
        (
            "call/screenFrames",
            serde_json::json!({"resourceId":"another-window"}),
        ),
        (
            "call/control",
            serde_json::json!({"resourceId":"another-window", "control":{"type":"stopScreenShare"}}),
        ),
    ].into_iter().enumerate() {
        let response: serde_json::Value = serde_json::from_str(
            &server.handle_json(
                &mut connection,
                &serde_json::json!({"jsonrpc":"2.0", "id":index + 2, "method":method, "params":params})
                    .to_string(),
            ),
        )
        .unwrap();
        assert_eq!(response["error"]["message"], "PermissionRequired", "{method}");
    }
}
