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
        let message: serde_json::Value = serde_json::from_str(request).unwrap();
        if message["method"] == "ide/request" {
            return Ok(serde_json::json!({"jsonrpc":"2.0", "id":message["id"], "result":{"type":"context", "window":null, "context":null}}).to_string());
        }
        *self.request.lock().expect("request lock is available") = Some(request.into());
        let mut response: serde_json::Value = serde_json::from_str(&self.response).unwrap();
        response["id"] = message["id"].clone();
        Ok(response.to_string())
    }
}

#[test]
fn submit_prompt_carries_every_collaboration_mode_to_the_app_server() {
    use ash_app_server_protocol::protocol::session::SessionRequest;
    use ash_app_server_protocol::protocol::session::SessionRequestParams;
    use ash_app_server_protocol::protocol::turn::TurnStartResult;
    for mode in crate::thread::composer::options::MODES {
        let recorded = Arc::new(Mutex::new(None));
        let result = SessionRequestResult::Turn(TurnStartResult {
            turn_id: TurnId::new("turn").unwrap(),
            sequence: 8,
        });
        let mut client = AppServerClient::new(RecordingTransport {
            request: Arc::clone(&recorded),
            response: serde_json::json!({"jsonrpc":"2.0","id":1,"result":result}).to_string(),
        });
        super::submit_prompt(
            &mut client,
            ThreadRequestScope::new(
                &SessionId::new("session").unwrap(),
                &ThreadId::new("thread").unwrap(),
                7,
            ),
            ChatSubmission {
                mode,
                command_id: ash_protocol::CommandId::new("submission").unwrap(),
                display_text: "work".into(),
                input: vec![ChatInputItem::Text("work".into())],
            },
            ash_protocol::ApprovalMode::Manual,
        )
        .unwrap();
        let request: serde_json::Value =
            serde_json::from_str(recorded.lock().unwrap().as_ref().unwrap()).unwrap();
        let params: SessionRequestParams =
            serde_json::from_value(request["params"].clone()).unwrap();
        let SessionRequest::StartTurn { mode: actual, .. } = params.request else {
            panic!("expected a start turn request")
        };
        assert_eq!(actual, mode);
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
            mode: Default::default(),
            command_id: ash_protocol::CommandId::new("submission").unwrap(),
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
    assert_eq!(request["params"]["commandId"], "submission");
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
            mode: Default::default(),
            command_id: ash_protocol::CommandId::new("submission").unwrap(),
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

#[test]
fn compact_submission_uses_the_typed_operation_and_retention_prompt() {
    use ash_app_server_protocol::protocol::session::SessionRequest;
    use ash_app_server_protocol::protocol::session::SessionRequestParams;
    use ash_app_server_protocol::protocol::turn::TurnStartResult;
    for (text, retention) in [
        ("/compact", None),
        (" /compact  ", None),
        (
            "/compact keep decisions\nand paths",
            Some("keep decisions\nand paths"),
        ),
        ("/compact\tkeep paths", Some("keep paths")),
    ] {
        let recorded = Arc::new(Mutex::new(None));
        let response = SessionRequestResult::Turn(TurnStartResult {
            turn_id: TurnId::new("compact-turn").unwrap(),
            sequence: 8,
        });
        let mut client = AppServerClient::new(RecordingTransport {
            request: Arc::clone(&recorded),
            response: serde_json::json!({"jsonrpc":"2.0","id":1,"result":response}).to_string(),
        });
        let result = super::submit_prompt(
            &mut client,
            ThreadRequestScope::new(
                &SessionId::new("session").unwrap(),
                &ThreadId::new("thread").unwrap(),
                7,
            ),
            ChatSubmission {
                mode: Default::default(),
                command_id: ash_protocol::CommandId::new("compact-command").unwrap(),
                display_text: text.into(),
                input: vec![ChatInputItem::Text(text.into())],
            },
            ash_protocol::ApprovalMode::Manual,
        )
        .unwrap();
        assert_eq!(result.turn_id.as_str(), "compact-turn");
        let request: serde_json::Value =
            serde_json::from_str(recorded.lock().unwrap().as_ref().unwrap()).unwrap();
        let params: SessionRequestParams =
            serde_json::from_value(request["params"].clone()).unwrap();
        assert_eq!(params.command_id.as_str(), "compact-command");
        assert_eq!(params.session_id.as_str(), "session");
        let SessionRequest::CompactContext {
            thread_id,
            expected_sequence,
            retention_prompt,
        } = params.request
        else {
            panic!("expected CompactContext");
        };
        assert_eq!(thread_id.as_str(), "thread");
        assert_eq!(expected_sequence, 7);
        assert_eq!(retention_prompt.as_deref(), retention);
    }
}

#[test]
fn ide_context_is_fresh_per_submission_and_pins_the_window_without_changing_user_text() {
    struct IdeTransport {
        requests: Arc<Mutex<Vec<serde_json::Value>>>,
    }
    impl JsonRpcTransport for IdeTransport {
        fn round_trip(&mut self, raw: &str) -> Result<String, ClientError> {
            let request: serde_json::Value = serde_json::from_str(raw).unwrap();
            self.requests.lock().unwrap().push(request.clone());
            let value = match request["method"].as_str().unwrap() {
                "ide/request" => {
                    let mut response = serde_json::json!({"type":"context", "window":{"id":"01234567890123456789012345678901", "title":"Project", "roots":["/project"]}, "context":{"activeFile":{"path":"/project/lib.rs", "version":2, "selections":[{"startLine":2,"startColumn":1,"endLine":2,"endColumn":4,"text":"new"}]},"openTabs":["/project/lib.rs"],"dirtyFiles":["/project/lib.rs"]}});
                    if self.requests.lock().unwrap().len() > 2 {
                        response["context"] = serde_json::Value::Null;
                    }
                    response
                }
                "session/request" => {
                    serde_json::json!({"type":"turn", "value":{"turnId":"turn", "sequence":8}})
                }
                method => panic!("unexpected request {method}"),
            };
            Ok(
                serde_json::json!({"jsonrpc":"2.0", "id":request["id"], "result":value})
                    .to_string(),
            )
        }
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(IdeTransport {
        requests: requests.clone(),
    });
    for index in 0..2 {
        super::submit_prompt(
            &mut client,
            ThreadRequestScope::new(
                &SessionId::new("session").unwrap(),
                &ThreadId::new("thread").unwrap(),
                7,
            ),
            ChatSubmission {
                mode: Default::default(),
                command_id: ash_protocol::CommandId::new(format!("submit-{index}")).unwrap(),
                display_text: "explain this".into(),
                input: vec![ChatInputItem::Text("explain this".into())],
            },
            ash_protocol::ApprovalMode::Manual,
        )
        .unwrap();
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for (index, pair) in requests.chunks(2).enumerate() {
        assert_eq!(pair[0]["params"]["sessionId"], "session");
        let turn = &pair[1]["params"]["request"];
        assert_eq!(turn["ideWindowId"], "01234567890123456789012345678901");
        assert_eq!(
            turn["input"][0],
            serde_json::json!({"type":"text","text":"explain this"})
        );
        if index == 1 {
            assert_eq!(
                turn["input"].as_array().unwrap().len(),
                1,
                "missing context must not replay a stale snapshot"
            );
            continue;
        }
        let context: serde_json::Value =
            serde_json::from_str(turn["input"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            context["context"]["activeFile"]["selections"][0]["text"],
            "new"
        );
        assert_eq!(context["context"]["dirtyFiles"][0], "/project/lib.rs");
    }
}
