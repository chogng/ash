use super::*;

#[test]
fn uploaded_audio_reaches_the_model_and_history_keeps_only_the_reference() {
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let bytes = include_bytes!("../../utils/audio/tests/fixtures/tone.wav");
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":2, "method":"attachment/upload/start",
            "params":{"mediaType":"wav","encodedBytes":bytes.len()}
        }),
    );
    let upload_id = started["result"]["uploadId"]
        .as_str()
        .expect("audio upload must start");
    for (index, chunk) in bytes.chunks(8192).enumerate() {
        let written = call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0", "id":10 + index, "method":"attachment/upload/write",
                "params":{"uploadId":upload_id,"offset":index * 8192,"dataBase64":base64::engine::general_purpose::STANDARD.encode(chunk)}
            }),
        );
        assert_eq!(
            written["result"]["nextOffset"],
            index * 8192 + chunk.len(),
            "{written}"
        );
    }
    let finished = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":20, "method":"attachment/upload/finish", "params":{"uploadId":upload_id}
        }),
    );
    let attachment = finished["result"]["attachment"].clone();
    assert_eq!(attachment["durationMs"], 1000, "{finished}");
    assert_eq!(attachment["mediaType"], "wav");
    let session = create_session(&server, &mut connection, 30, "audio-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 31, "audio-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":32, "method":"session/request",
            "params":{"commandId":"audio-turn","sessionId":session_id,"request":{
                "type":"startTurn","expectedSequence":1,"threadId":thread_id,
                "input":[{"type":"text","text":"Listen"},{"type":"audioAttachment","attachment":attachment},{"type":"text","text":"Describe"}]
            }}
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    let durable = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ash_protocol::ThreadItem::UserAudioAttachment { attachment, .. } => Some(attachment),
            _ => None,
        })
        .expect("history must retain the audio reference");
    assert_eq!(serde_json::to_value(durable).unwrap(), attachment);
    assert!(
        !serde_json::to_string(&snapshot.public_thread())
            .unwrap()
            .contains("data:audio")
    );
    let requests = model.requests.lock().unwrap();
    let content = requests
        .last()
        .unwrap()
        .input
        .iter()
        .find_map(|item| match item {
            ash_protocol::InputItem::Message(message)
                if message
                    .content
                    .iter()
                    .any(|part| matches!(part, ash_protocol::ContentPart::AudioUrl { .. })) =>
            {
                Some(&message.content)
            }
            _ => None,
        })
        .expect("provider must receive materialized audio");
    assert!(
        matches!(content.as_slice(), [ash_protocol::ContentPart::Text(before), ash_protocol::ContentPart::AudioUrl { url }, ash_protocol::ContentPart::Text(after)] if before == "Listen" && after == "Describe" && url.starts_with("data:audio/wav;base64,"))
    );
}
