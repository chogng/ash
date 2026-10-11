use super::call;
use super::initialize;
use super::server;
use ash_state::SqliteMessageHistory;
use message_history::MessageHistoryRetention;
use serde_json::json;
use std::sync::Arc;

#[test]
fn message_history_shares_profile_storage_and_uses_stable_older_cursors() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let store =
        Arc::new(SqliteMessageHistory::open(&path, MessageHistoryRetention::default()).unwrap());
    let server = server().with_message_history_store(store);
    let mut first = server.product_host_connection();
    let mut second = server.product_host_connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    for (index, text) in ["First draft\nsecond line", "Second draft", "Third draft"]
        .into_iter()
        .enumerate()
    {
        let response = call(
            &server,
            &mut first,
            json!({
                "jsonrpc":"2.0", "id": index + 2, "method": "messageHistory/append", "params": {
                    "text": text, "kind": "agent", "threadId": "informational-origin"
                }
            }),
        );
        assert!(response.get("error").is_none(), "{response}");
        assert!(response["result"]["id"].is_string());
    }
    let page = call(
        &server,
        &mut second,
        json!({
            "jsonrpc":"2.0", "id": 2, "method": "messageHistory/read", "params": { "before": null, "text": "", "kind": "agent", "limit": 2 }
        }),
    );
    assert_eq!(page["result"]["entries"][0]["text"], "Third draft");
    assert_eq!(page["result"]["entries"].as_array().unwrap().len(), 2);
    let older = call(
        &server,
        &mut second,
        json!({
            "jsonrpc":"2.0", "id": 3, "method": "messageHistory/read", "params": {
                "before": page["result"]["nextBefore"], "text": "", "kind": null, "limit": 2
            }
        }),
    );
    assert_eq!(
        older["result"]["entries"][0]["text"],
        "First draft\nsecond line"
    );
    let search = call(
        &server,
        &mut second,
        json!({
            "jsonrpc":"2.0", "id": 4, "method": "messageHistory/read", "params": { "before": null, "text": "SECOND LINE", "kind": null, "limit": 2 }
        }),
    );
    assert_eq!(search["result"]["entries"].as_array().unwrap().len(), 1);
    drop(server);
    let server = super::server().with_message_history_store(Arc::new(
        SqliteMessageHistory::open(&path, MessageHistoryRetention::default()).unwrap(),
    ));
    let mut connection = server.product_host_connection();
    initialize(&server, &mut connection);
    let recovered = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id": 2, "method": "messageHistory/read", "params": { "before": null, "text": "", "kind": null, "limit": 128 }
        }),
    );
    assert_eq!(recovered["result"]["entries"].as_array().unwrap().len(), 3);
    let cleared = call(
        &server,
        &mut connection,
        json!({ "jsonrpc":"2.0", "id": 3, "method": "messageHistory/clear", "params": {} }),
    );
    assert!(cleared.get("error").is_none(), "{cleared}");
    let empty = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id": 4, "method": "messageHistory/read", "params": { "before": null, "text": "", "kind": null, "limit": 128 }
        }),
    );
    assert_eq!(empty["result"]["entries"], json!([]));
}

#[test]
fn message_history_rejects_untrusted_connections_and_invalid_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteMessageHistory::open(
            &directory.path().join("state.db"),
            MessageHistoryRetention::default(),
        )
        .unwrap(),
    );
    let server = server().with_message_history_store(store);
    let mut client = server.connection();
    initialize(&server, &mut client);
    for (index, (method, params)) in [
        (
            "messageHistory/read",
            json!({"before":null,"text":"","kind":null,"limit":20}),
        ),
        (
            "messageHistory/append",
            json!({"text":"private draft","kind":"agent","threadId":null}),
        ),
        ("messageHistory/clear", json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        let response = call(
            &server,
            &mut client,
            json!({"jsonrpc":"2.0", "id":index+2,"method":method,"params":params}),
        );
        assert_eq!(response["error"]["message"], "ResourceNotOwner");
    }
    let mut host = server.product_host_connection();
    initialize(&server, &mut host);
    let invalid = call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0", "id":2,"method":"messageHistory/append","params":{"text":"  ","kind":"agent","threadId":null}}),
    );
    assert_eq!(invalid["error"]["code"], -32602);
    for (index, before) in ["0", "-1", "9223372036854775808", "not-a-cursor"]
        .into_iter()
        .enumerate()
    {
        let response = call(
            &server,
            &mut host,
            json!({"jsonrpc":"2.0", "id":index+3,"method":"messageHistory/read","params":{"before":before,"text":"","kind":null,"limit":20}}),
        );
        assert_eq!(response["error"]["code"], -32602, "{response}");
    }
}
