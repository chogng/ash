use super::ThreadRequestScope;
use super::steer_prompt;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::ChatSubmission;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::turn::TurnSteerResult;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::sync::Arc;
use std::sync::Mutex;

struct RecordingTransport {
    request: Arc<Mutex<Option<String>>>,
    response: String,
}

#[test]
fn request_scope_matches_only_the_session_and_thread_that_started_it() {
    let session = SessionId::new("session-1").unwrap();
    let thread = ThreadId::new("thread-1").unwrap();
    let scope = ThreadRequestScope::new(&session, &thread, 7);

    assert!(scope.targets(&session, &thread));
    assert!(!scope.targets(&SessionId::new("session-2").unwrap(), &thread));
    assert!(!scope.targets(&session, &ThreadId::new("thread-2").unwrap()));
}

impl JsonRpcTransport for RecordingTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        *self.request.lock().expect("request lock is available") = Some(request.into());
        Ok(self.response.clone())
    }
}

#[test]
fn steer_prompt_uses_the_active_turn_typed_request() {
    let recorded = Arc::new(Mutex::new(None));
    let result = SessionRequestResult::TurnSteer(TurnSteerResult {
        turn_id: TurnId::new("turn-1").unwrap(),
        sequence: 8,
    });
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": serde_json::to_value(result).unwrap(),
    })
    .to_string();
    let mut client = AppServerClient::new(RecordingTransport {
        request: Arc::clone(&recorded),
        response,
    });

    let result = steer_prompt(
        &mut client,
        ThreadRequestScope::new(
            &SessionId::new("session-1").unwrap(),
            &ThreadId::new("thread-1").unwrap(),
            7,
        ),
        TurnId::new("turn-1").unwrap(),
        ChatSubmission {
            display_text: "change direction".into(),
            input: vec![ChatInputItem::Text("change direction".into())],
        },
    )
    .unwrap();

    assert_eq!(result.sequence, 8);
    let request = recorded
        .lock()
        .expect("request lock is available")
        .clone()
        .expect("request is recorded");
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "session/request");
    assert_eq!(request["params"]["request"]["type"], "steerTurn");
    assert_eq!(request["params"]["request"]["threadId"], "thread-1");
    assert_eq!(request["params"]["request"]["expectedSequence"], 7);
    assert_eq!(request["params"]["request"]["turnId"], "turn-1");
    assert_eq!(
        request["params"]["request"]["input"][0]["text"],
        "change direction"
    );
}

#[test]
fn audio_steering_preserves_the_uploaded_attachment_reference() {
    let recorded = Arc::new(Mutex::new(None));
    let result = SessionRequestResult::TurnSteer(TurnSteerResult {
        turn_id: TurnId::new("turn").unwrap(),
        sequence: 8,
    });
    let mut client = AppServerClient::new(RecordingTransport {
        request: recorded.clone(),
        response: serde_json::json!({"jsonrpc":"2.0","id":1,"result":result}).to_string(),
    });
    let attachment = ash_protocol::AudioAttachmentRef {
        content_digest: ash_protocol::ContentDigest::sha256(b"recording"),
        media_type: ash_protocol::AudioMediaType::Wav,
        encoded_bytes: 32044,
        duration_ms: 1000,
    };
    steer_prompt(
        &mut client,
        ThreadRequestScope::new(
            &SessionId::new("session").unwrap(),
            &ThreadId::new("thread").unwrap(),
            7,
        ),
        TurnId::new("turn").unwrap(),
        ChatSubmission {
            display_text: "[Audio]".into(),
            input: vec![ChatInputItem::AudioAttachment(attachment.clone())],
        },
    )
    .unwrap();
    let request: serde_json::Value =
        serde_json::from_str(recorded.lock().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(
        request["params"]["request"]["input"],
        serde_json::json!([{"type":"audioAttachment","attachment":attachment}])
    );
}
