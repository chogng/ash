use super::AppServer;
use ash_core::RecordToolCallRequest;
use ash_core::RecordToolResultRequest;
use ash_core::StartTurnRequest;
use ash_core::ToolCallOutput;
use ash_protocol::CommandId;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolName;
use ash_protocol::UserInput;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use serde_json::json;
use std::io::Cursor;

#[test]
fn attachment_resource_open_reads_only_selected_thread_media_and_keeps_connection_ownership() {
    let server = crate::tests::server();
    let mut owner = server.connection();
    let mut other = server.connection();
    crate::tests::initialize(&server, &mut owner);
    crate::tests::initialize(&server, &mut other);
    let session = crate::tests::call(&server, &mut owner, json!({
        "jsonrpc":"2.0","id":2,"method":"session/create",
        "params":{"commandId":"media-session","title":"Media","executionTarget":null}
    }));
    let session_id = SessionId::new(session["result"]["session"]["sessionId"].as_str().unwrap()).unwrap();
    let thread_id = ThreadId::new(session["result"]["session"]["threads"][0]["threadId"].as_str().unwrap()).unwrap();
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 1).write_to(&mut encoded, image::ImageFormat::Png).unwrap();
    let image = server.threads().attachments().import_bytes(encoded.into_inner(), ImageMediaType::Png).unwrap();
    let audio = server.threads().attachments().import_audio_bytes(
        include_bytes!("../../../utils/audio/tests/fixtures/tone.wav").to_vec(), ash_protocol::AudioMediaType::Wav,
    ).unwrap();
    let sequence = server.threads().read_thread(&thread_id).unwrap().sequence;
    let started = server.threads().start_turn(&thread_id, StartTurnRequest {
        context_policy: Default::default(), mode: Default::default(), advisor: None,
        kind: ash_protocol::TurnKind::Coding, instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
        command_id: CommandId::new("media-turn").unwrap(), expected_sequence: core_api::SequenceExpectation::Exact(sequence),
        model: None, reasoning_effort: None, policy_revision: "test-policy".into(), approval_mode: ash_protocol::ApprovalMode::Manual,
        tool_mode: ash_protocol::ToolMode::Direct, tool_profile: None, activated_skills: Vec::new(),
        input: vec![UserInput::ImageAttachment { attachment: image.clone(), detail: ImageDetail::Auto }, UserInput::AudioAttachment { attachment: audio.clone() }],
    }).unwrap();
    let snapshot = server.threads().read_thread(&thread_id).unwrap();
    for item in &snapshot.items {
        let (mime, bytes) = match item {
            ThreadItem::UserImageAttachment { attachment, .. } => (attachment.media_type.mime_type(), server.threads().attachments().read_image(attachment).unwrap().to_vec()),
            ThreadItem::UserAudioAttachment { attachment, .. } => (attachment.media_type.mime_type(), server.threads().attachments().read_audio(attachment).unwrap().bytes().to_vec()),
            _ => continue,
        };
        let params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":item.item_id()});
        let opened = crate::tests::call(&server, &mut owner, json!({"jsonrpc":"2.0","id":3,"method":"attachment/resource/open","params":params}));
        assert_eq!(opened["result"]["mimeType"], mime, "{opened}");
        let resource = opened["result"]["resourceId"].as_str().unwrap();
        let read = crate::tests::call(&server, &mut owner, json!({"jsonrpc":"2.0","id":4,"method":"resource/read","params":{"resourceId":resource,"offset":0,"maxBytes":262144}}));
        assert_eq!(STANDARD.decode(read["result"]["dataBase64"].as_str().unwrap()).unwrap(), bytes);
        let denied = crate::tests::call(&server, &mut other, json!({"jsonrpc":"2.0","id":5,"method":"resource/read","params":{"resourceId":resource,"offset":0,"maxBytes":262144}}));
        assert_eq!(denied["error"]["message"], "ResourceNotOwner");
        let mut wrong_session = params.clone();
        wrong_session["sessionId"] = json!("another-session");
        assert!(open(&server, &mut owner, wrong_session).get("error").is_some());
        let mut wrong_item = params.clone();
        wrong_item["itemId"] = json!("missing-item");
        assert_eq!(open(&server, &mut owner, wrong_item)["error"]["message"], "ResourceNotFound");
        let mut wrong_index = params;
        wrong_index["contentIndex"] = json!(0);
        assert_eq!(open(&server, &mut owner, wrong_index)["error"]["message"], "InvalidParams");
    }
    let call = server.threads().record_tool_call(&thread_id, &started.turn_id, RecordToolCallRequest {
        tool_call_id: None, name: ToolName::new("media").unwrap(), arguments_json: "{}".into(), binding: None,
    }).unwrap();
    let result = server.threads().record_tool_result(&thread_id, &started.turn_id, RecordToolResultRequest {
        tool_call_id: call.tool_call_id,
        output: ToolCallOutput::SuccessContent(vec![ContentPart::ImageAttachment { attachment: image, detail: ImageDetail::Auto }, ContentPart::AudioAttachment { attachment: audio }, ContentPart::Text("plain text".into())]),
    }).unwrap();
    let params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id()});
    assert_eq!(open(&server, &mut owner, params.clone())["error"]["message"], "InvalidParams");
    for (index, mime) in [(0, "image/png"), (1, "audio/wav")] {
        let mut selected = params.clone();
        selected["contentIndex"] = json!(index);
        assert_eq!(open(&server, &mut owner, selected)["result"]["mimeType"], mime);
    }
    for index in [2, 100] {
        let mut selected = params.clone();
        selected["contentIndex"] = json!(index);
        assert_eq!(open(&server, &mut owner, selected)["error"]["message"], "InvalidParams");
    }
}

fn open(server: &AppServer, connection: &mut super::ConnectionState, params: Value) -> Value {
    crate::tests::call(server, connection, json!({"jsonrpc":"2.0","id":20,"method":"attachment/resource/open","params":params}))
}
