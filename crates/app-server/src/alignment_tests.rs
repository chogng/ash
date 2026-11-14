use super::*;
use serde_json::json;

#[test]
fn session_list_inclusion_exclusion_and_validation_are_applied_by_the_server() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let first = create_session(&server, &mut connection, 2, "saved-first");
    let second = create_session(&server, &mut connection, 3, "saved-second");
    let first = first["result"]["session"]["sessionId"].as_str().unwrap();
    let second = second["result"]["session"]["sessionId"].as_str().unwrap();
    for (index, (params, expected)) in [
        (json!({}), 2),
        (json!({"includedSessionIds":null}), 2),
        (json!({"includedSessionIds":[]}), 0),
        (
            json!({"includedSessionIds":[second, first, "missing"], "excludedSessionIds":[first]}),
            1,
        ),
        (json!({"includedSessionIds":[second], "archived":true}), 0),
    ]
    .into_iter()
    .enumerate()
    {
        let response = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":index+10,"method":"session/list","params":params}),
        );
        assert_eq!(
            response["result"]["sessions"].as_array().unwrap().len(),
            expected,
            "{response}"
        );
    }
    for (index, params) in [
        json!({"includedSessionIds":vec![first; 101]}),
        json!({"excludedSessionIds":vec![first; 101]}),
        json!({"includedSessionIds":[""]}),
    ]
    .into_iter()
    .enumerate()
    {
        let response = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":index+20,"method":"session/list","params":params}),
        );
        assert_eq!(response["error"]["code"], -32602, "{response}");
    }
}

#[test]
fn voice_history_rpc_reads_acknowledged_records_without_a_live_voice_runtime() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = create_session(&server, &mut connection, 2, "voice-history");
    let session = created["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = ash_protocol::ThreadId::new(session).unwrap();
    let receipt = server
        .threads()
        .record_voice_transcript(
            &thread,
            ash_core::RecordVoiceTranscriptRequest {
                voice_session_id: "call".into(),
                media_epoch: 1,
                speaker: ash_protocol::VoiceTranscriptSpeaker::User,
                text: "persisted".into(),
                start_ms: 0,
                end_ms: 100,
            },
        )
        .unwrap();
    let response = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":3,"method":"session/thread/voice/history","params":{"sessionId":session,"threadId":session,"requiredSequence":receipt.sequence,"limit":10}}),
    );
    assert_eq!(response["result"]["coverage"], "ready", "{response}");
    assert_eq!(
        response["result"]["entries"][0]["transcript"]["text"],
        "persisted"
    );
    let response = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":4,"method":"session/thread/voice/history","params":{"sessionId":"wrong","threadId":session,"limit":10}}),
    );
    assert!(response.get("error").is_some(), "{response}");
}
