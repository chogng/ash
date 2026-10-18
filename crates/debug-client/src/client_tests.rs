use std::time::Duration;

use serde_json::json;

use super::DebugClient;
use super::DebugClientError;
use super::DebugResponse;

#[test]
fn pairs_out_of_order_zero_sequence_responses_and_preserves_null_bodies() {
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (first, first_message) = client.request("one", None).unwrap();
    let (second, second_message) = client.request("two", Some(json!(null))).unwrap();
    assert!(first_message.get("arguments").is_none());
    assert_eq!(second_message["arguments"], json!(null));
    client.accept(&json!({"seq":0,"type":"response","request_seq":second,"command":"two","success":true,"body":null})).unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":first,"command":"one","success":false,"message":"denied"})).unwrap();
    let DebugResponse::Complete(response) = client.response(second).unwrap() else {
        panic!()
    };
    assert_eq!(response.get("body"), Some(&json!(null)));
    let DebugResponse::Complete(response) = client.response(first).unwrap() else {
        panic!()
    };
    assert!(response.get("body").is_none());
    assert_eq!(response["message"], "denied");
    assert!(matches!(
        client.response(first),
        Err(DebugClientError::UnknownRequest)
    ));
}

#[test]
fn reverse_requests_use_the_same_outgoing_sequence_and_reject_forged_replies() {
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (first, _) = client.request("launch", None).unwrap();
    client
        .accept(&json!({"seq":0,"type":"request","command":"runInTerminal"}))
        .unwrap();
    assert!(
        client
            .reply(json!({"type":"response","request_seq":0,"command":"other","success":true}))
            .is_err()
    );
    let response = client.reply(json!({"seq":999,"type":"response","request_seq":0,"command":"runInTerminal","success":true})).unwrap();
    assert_eq!(response["seq"], first + 1);
    assert!(client.reply(response).is_err());
    assert_eq!(client.request("next", None).unwrap().0, first + 2);
}

#[test]
fn expiry_and_close_settle_waiters_without_accepting_late_success() {
    let mut client = DebugClient::new(Duration::ZERO);
    let (id, _) = client.request("evaluate", None).unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":id,"command":"evaluate","success":true,"body":{"result":"late"}})).unwrap();
    assert!(
        matches!(client.response(id).unwrap(), DebugResponse::Failed(message) if message.contains("timed out"))
    );
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, _) = client.request("launch", None).unwrap();
    client.close("connection closed");
    assert!(
        matches!(client.response(id).unwrap(), DebugResponse::Failed(message) if message == "connection closed")
    );
    assert!(matches!(
        client.request("launch", None),
        Err(DebugClientError::Closed)
    ));
}

#[test]
fn malformed_envelopes_and_mismatched_commands_do_not_complete_a_waiter() {
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, _) = client.request("continue", None).unwrap();
    for value in [
        json!({"seq":-1,"type":"event","event":"stopped"}),
        json!({"seq":0,"type":"response","request_seq":id,"command":"other","success":true}),
        json!({"seq":0,"type":"response","request_seq":id,"command":"continue","success":"yes"}),
    ] {
        assert!(client.accept(&value).is_err());
    }
    assert!(matches!(
        client.response(id).unwrap(),
        DebugResponse::Pending
    ));
}

#[test]
fn unconsumed_results_and_reverse_requests_are_bounded() {
    let mut client = DebugClient::new(Duration::from_secs(15));
    for _ in 0..128 {
        client.request("custom", None).unwrap();
    }
    assert!(matches!(
        client.request("overflow", None),
        Err(DebugClientError::Capacity)
    ));
    for seq in 0..128 {
        client
            .accept(&json!({"seq":seq,"type":"request","command":"custom"}))
            .unwrap();
    }
    assert!(matches!(
        client.accept(&json!({"seq":128,"type":"request","command":"custom"})),
        Err(DebugClientError::Capacity)
    ));
}
