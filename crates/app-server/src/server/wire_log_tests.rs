use super::*;
use serde_json::json;

fn params() -> WireLogParams {
    WireLogParams {
        capture_id: "capture-1".into(),
    }
}
fn page(log: &WireLog, after: u64, limit: u32) -> WireLogPage {
    log.read(
        7,
        &WireLogReadParams {
            capture_id: "capture-1".into(),
            after,
            limit,
        },
    )
    .unwrap()
}
fn incoming(log: &mut WireLog, value: Value) {
    log.received(&value.to_string(), &value);
}

#[test]
fn wire_log_is_opt_in_excludes_its_own_frames_and_preserves_raw_bytes() {
    let mut log = WireLog::default();
    incoming(&mut log, json!({"id":1,"method":"session/list"}));
    incoming(
        &mut log,
        json!({"id":2,"method":"diagnostics/wireLog/start"}),
    );
    log.start(&params()).unwrap();
    log.sent(r#"{"id":2,"result":null}"#);
    let raw = "{ \"id\":3, \"method\":\"session/read\", \"params\":{} }";
    log.received(raw, &serde_json::from_str(raw).unwrap());
    log.sent(r#"{"id":3,"error":{"code":-1}}"#);
    let result = page(&log, 0, 100);
    assert_eq!(result.frames.len(), 2);
    assert_eq!(result.frames[0].raw, raw);
    assert_eq!(result.frames[0].byte_length as usize, raw.len());
    assert_eq!(result.frames[1].request_sequence, Some(1));
    assert_eq!(result.frames[1].method.as_deref(), Some("session/read"));
    assert!(result.frames[1].is_error);
    assert_eq!(result.connection_id, "7");
}

#[test]
fn wire_log_pairs_each_direction_and_preserves_orphans_and_notifications() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    incoming(&mut log, json!({"id":1,"method":"client"}));
    log.sent(r#"{"id":1,"method":"host"}"#);
    incoming(&mut log, json!({"id":1,"result":null}));
    log.sent(r#"{"id":1,"result":null}"#);
    log.sent(r#"{"id":99,"result":null}"#);
    log.sent(r#"{"method":"thread/updated","params":{}}"#);
    let frames = page(&log, 0, 100).frames;
    assert_eq!(frames[2].request_sequence, Some(2));
    assert_eq!(frames[3].request_sequence, Some(1));
    assert_eq!(frames[4].request_sequence, None);
    assert_eq!(frames[5].kind, WireLogFrameKind::Notification);
}

#[test]
fn wire_log_paginates_bounds_memory_and_never_splits_utf8() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    for _ in 0..MAX_FRAMES + 7 {
        log.sent(r#"{"method":"tick"}"#);
    }
    let first = page(&log, 0, 2);
    assert_eq!(first.dropped_frames, 7);
    assert_eq!(first.frames[0].sequence, 8);
    assert!(first.has_more);
    assert_eq!(
        page(&log, first.cursor, 2).frames[0].sequence,
        first.cursor + 1
    );
    let raw = json!({"method":"large","params":"帧".repeat(MAX_FRAME_BYTES)}).to_string();
    log.sent(&raw);
    let capture = log.capture.as_ref().unwrap();
    let frame = capture.frames.back().unwrap();
    assert!(frame.truncated);
    assert!(frame.raw.len() <= MAX_FRAME_BYTES);
    assert!(raw.starts_with(&frame.raw));
    assert_eq!(frame.byte_length as usize, raw.len());
    for _ in 0..60 {
        log.sent(&raw);
    }
    let capture = log.capture.as_ref().unwrap();
    assert!(capture.bytes <= MAX_BYTES);
    assert!(
        page(&log, 0, 100)
            .frames
            .iter()
            .map(|f| f.raw.len())
            .sum::<usize>()
            <= PAGE_BYTES
    );
}

#[test]
fn wire_log_stop_is_acknowledged_idempotent_and_close_prevents_late_start() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    assert!(log.start(&params()).is_err());
    assert!(
        WireLog::default()
            .read(
                7,
                &WireLogReadParams {
                    capture_id: "capture-1".into(),
                    after: 0,
                    limit: 1
                }
            )
            .is_err()
    );
    log.sent(r#"{"method":"before"}"#);
    log.stop(&params()).unwrap();
    log.stop(&params()).unwrap();
    log.sent(r#"{"method":"after"}"#);
    assert_eq!(page(&log, 0, 100).frames.len(), 1);
    assert!(!page(&log, 0, 100).recording);
    assert!(
        log.read(
            7,
            &WireLogReadParams {
                capture_id: "capture-1".into(),
                after: 2,
                limit: 1
            }
        )
        .is_err()
    );
    assert!(
        log.start(&WireLogParams {
            capture_id: "../invalid".into()
        })
        .is_err()
    );
    log.close();
    assert!(log.capture.is_none());
    assert!(log.start(&params()).is_err());
}

#[test]
fn wire_log_never_guesses_response_ownership_for_replayed_ids() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    incoming(&mut log, json!({"id":1,"method":"original"}));
    incoming(&mut log, json!({"id":1,"method":"replayed"}));
    log.sent(r#"{"id":1,"error":{"code":-32600}}"#);
    log.sent(r#"{"id":1,"result":null}"#);
    // A string ID is a distinct protocol identity, even when it contains the same digits.
    log.sent(r#"{"id":"1","method":"host/call"}"#);
    incoming(&mut log, json!({"id":"1","result":null}));
    let frames = page(&log, 0, 100).frames;
    assert!(
        frames[2..4]
            .iter()
            .all(|frame| frame.request_sequence.is_none() && frame.elapsed_ms.is_none())
    );
    assert_eq!(frames[5].request_sequence, Some(5));
    for _ in 0..MAX_FRAMES {
        log.sent(r#"{"method":"tick"}"#);
    }
    assert!(log.capture.as_ref().unwrap().pending.is_empty());
}

#[test]
fn wire_log_bounds_untrusted_metadata_without_changing_the_frame_kind() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    incoming(
        &mut log,
        json!({"id":{"untrusted":"x".repeat(MAX_FRAME_BYTES)},"method":"m".repeat(1024)}),
    );
    incoming(
        &mut log,
        json!({"id":"x".repeat(1024),"method":"session/read"}),
    );
    let frames = page(&log, 0, 100).frames;
    assert_eq!(frames[0].kind, WireLogFrameKind::Request);
    assert!(frames[0].method.is_none());
    assert!(frames[0].request_id.is_none());
    assert!(frames[0].truncated);
    assert_eq!(frames[1].kind, WireLogFrameKind::Request);
    assert!(frames[1].request_id.is_none());
    assert!(log.capture.as_ref().unwrap().pending.is_empty());
}

#[test]
fn wire_log_redacts_session_environment_values_even_for_unpaired_replies() {
    let mut log = WireLog::default();
    log.start(&params()).unwrap();
    incoming(
        &mut log,
        json!({
            "id": 1, "method": "session/environmentProfile/save",
            "params": { "environmentId": "profile", "variables": {"MODE": "secret-value"} }
        }),
    );
    incoming(
        &mut log,
        json!({
            "id": 2, "method": "session/create",
            "params": { "environmentVariables": {"MODE": "secret-value"} }
        }),
    );
    log.sent(r#"{"id":99,"result":{"variables":{"MODE":"secret-value"}}}"#);
    let frames = page(&log, 0, 100).frames;
    assert_eq!(frames.len(), 3);
    assert!(
        frames
            .iter()
            .all(|frame| frame.raw.contains("[REDACTED]") && !frame.raw.contains("secret-value"))
    );
}
