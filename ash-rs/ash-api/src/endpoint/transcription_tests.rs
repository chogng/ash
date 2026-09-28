use super::*;

#[test]
fn transcription_events_keep_audio_item_identity_and_final_text() {
    assert_eq!(
        TranscriptionSession::decode_event(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "speech-1",
            "delta": "你好"
        }))
        .unwrap(),
        TranscriptionEvent::Delta {
            item_id: "speech-1".into(),
            text: "你好".into()
        }
    );
    assert_eq!(
        TranscriptionSession::decode_event(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "speech-1",
            "transcript": "你好，世界"
        }))
        .unwrap(),
        TranscriptionEvent::Completed {
            item_id: "speech-1".into(),
            text: "你好，世界".into()
        }
    );
}

#[test]
fn transcription_rejects_missing_audio_item_identity() {
    assert!(
        TranscriptionSession::decode_event(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "hello"
        }))
        .is_err()
    );
}
