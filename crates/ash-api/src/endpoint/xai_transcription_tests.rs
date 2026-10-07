use super::XaiTranscriptionEvent;
use super::XaiTranscriptionSession;
use serde_json::json;

#[test]
fn phrase_boundary_and_session_completion_are_distinct() {
    assert_eq!(
        XaiTranscriptionSession::decode_event(&json!({
            "type": "transcript.partial",
            "text": "first phrase",
            "is_final": true,
            "speech_final": true
        }))
        .unwrap(),
        XaiTranscriptionEvent::Partial {
            text: "first phrase".into(),
            is_final: true,
            speech_final: true,
        }
    );
    assert_eq!(
        XaiTranscriptionSession::decode_event(&json!({
            "type": "transcript.done", "text": "last phrase"
        }))
        .unwrap(),
        XaiTranscriptionEvent::Done {
            text: "last phrase".into()
        }
    );
    assert!(XaiTranscriptionSession::decode_event(&json!({"type":"error"})).is_err());
}
