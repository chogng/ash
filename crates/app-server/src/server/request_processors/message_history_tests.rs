use super::ConnectionAuthority;
use super::MessageHistoryRequestProcessor;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_state::SqliteMessageHistory;
use message_history::MessageHistoryRetention;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[test]
fn message_history_processors_share_profile_inputs_across_trusted_authorities() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteMessageHistory::open(
            &directory.path().join("state.db"),
            MessageHistoryRetention::default(),
        )
        .unwrap(),
    );
    let writer = MessageHistoryRequestProcessor::new(store.clone());
    let reader = MessageHistoryRequestProcessor::new(store);
    for kind in ["agent", "shell", "command"] {
        let entry = writer
            .append(
                ConnectionAuthority::ProductHost,
                &json!({"text":"未提交\n输入","kind":kind,"threadId":"informational-origin"}),
            )
            .unwrap();
        assert!(entry["id"].is_string());
        assert_eq!(entry["kind"], kind);
        assert_eq!(entry["threadId"], "informational-origin");
    }
    let query = json!({"before":null,"text":"","kind":null,"limit":20});
    let history = reader.read(ConnectionAuthority::Browser, &query).unwrap();
    assert_eq!(history["entries"].as_array().unwrap().len(), 3);
    assert_eq!(history["entries"][0]["kind"], "command");
    assert_eq!(history["entries"][0]["text"], "未提交\n输入");
    assert_eq!(
        reader.clear(ConnectionAuthority::Browser).unwrap(),
        Value::Null
    );
    assert_eq!(
        writer
            .read(ConnectionAuthority::ProductHost, &query)
            .unwrap()["entries"],
        json!([])
    );
}

#[test]
fn message_history_processor_checks_authority_and_availability_before_decoding() {
    let directory = tempfile::tempdir().unwrap();
    let configured = MessageHistoryRequestProcessor::new(Arc::new(
        SqliteMessageHistory::open(
            &directory.path().join("state.db"),
            MessageHistoryRetention::default(),
        )
        .unwrap(),
    ));
    let unavailable = MessageHistoryRequestProcessor::default();
    for processor in [&configured, &unavailable] {
        assert!(!processor.is_available(ConnectionAuthority::Client));
        for denied in [
            processor.append(ConnectionAuthority::Client, &Value::Null),
            processor.read(ConnectionAuthority::Client, &Value::Null),
            processor.clear(ConnectionAuthority::Client),
        ] {
            let error = denied.unwrap_err();
            assert_eq!(error.code, -32000);
            assert_eq!(error.message, AppServerErrorName::ResourceNotOwner);
        }
    }
    for authority in [
        ConnectionAuthority::ProductHost,
        ConnectionAuthority::Browser,
    ] {
        assert!(configured.is_available(authority));
        assert!(!unavailable.is_available(authority));
        for missing in [
            unavailable.append(authority, &Value::Null),
            unavailable.read(authority, &Value::Null),
            unavailable.clear(authority),
        ] {
            let error = missing.unwrap_err();
            assert_eq!(error.code, -32540);
            assert_eq!(error.message, AppServerErrorName::MessageHistoryUnavailable);
        }
        for invalid in [
            configured.append(authority, &Value::Null),
            configured.read(authority, &Value::Null),
        ] {
            let error = invalid.unwrap_err();
            assert_eq!(error.code, -32602);
            assert_eq!(error.message, AppServerErrorName::InvalidParams);
        }
    }
}

#[test]
fn message_history_initialize_capability_matches_rpc_access_for_every_authority() {
    let directory = tempfile::tempdir().unwrap();
    let configured = crate::tests::server().with_message_history_store(Arc::new(
        SqliteMessageHistory::open(
            &directory.path().join("state.db"),
            MessageHistoryRetention::default(),
        )
        .unwrap(),
    ));
    let unavailable = crate::tests::server();
    for (server, trusted_error) in [
        (&configured, None),
        (&unavailable, Some("MessageHistoryUnavailable")),
    ] {
        for (mut connection, expected_error) in [
            (server.connection(), Some("ResourceNotOwner")),
            (server.product_host_connection(), trusted_error),
            (server.browser_connection(), trusted_error),
        ] {
            let initialized = crate::tests::call(
                server,
                &mut connection,
                json!({
                    "jsonrpc":"2.0","id":1,"method":"initialize",
                    "params":{"clientInfo":{"name":"message-history-test","version":"1"},"capabilities":{}}
                }),
            );
            assert!(initialized.get("result").is_some(), "{initialized}");
            let contract = &initialized["result"]["capabilities"]["contracts"]["messageHistory"];
            assert_eq!(contract.is_object(), expected_error.is_none());
            if expected_error.is_none() {
                assert_eq!(contract["version"], 1);
            }
            let read = crate::tests::call(
                server,
                &mut connection,
                json!({
                    "jsonrpc":"2.0","id":2,"method":"messageHistory/read",
                    "params":{"before":null,"text":"","kind":null,"limit":20}
                }),
            );
            if let Some(error) = expected_error {
                assert_eq!(read["error"]["message"], error, "{read}");
            } else {
                assert_eq!(read["result"]["entries"], json!([]), "{read}");
            }
            server.close_connection(connection);
        }
    }
}
