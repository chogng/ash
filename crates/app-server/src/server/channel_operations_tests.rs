use crate::tests::call;
use crate::tests::initialize;
use crate::tests::server;
use serde_json::json;
use std::sync::Arc;

#[test]
fn channel_rpc_uses_profile_storage_and_rejects_untrusted_connections() {
    let server = server().with_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let mut first = server.product_host_connection();
    let mut second = server.product_host_connection();
    let mut browser = server.browser_connection();
    let mut untrusted = server.connection();
    for connection in [&mut first, &mut second, &mut browser] {
        initialize(&server, connection);
        let reply = call(
            &server,
            connection,
            json!({"jsonrpc":"2.0","id":2,"method":"channels/read","params":{}}),
        );
        assert_eq!(reply["result"], serde_json::Value::Null);
        assert!(reply.get("error").is_none(), "{reply}");
        for (index, method) in ["channels/notes", "channels/call"].iter().enumerate() {
            let resource = call(
                &server,
                connection,
                json!({"jsonrpc":"2.0","id":6 + index,"method":method,"params":{"spaceId":"a".repeat(64),"channelId":"b".repeat(64)}}),
            );
            assert_eq!(
                resource["error"]["data"]["kind"], "ChannelDenied",
                "{resource}"
            );
        }
        let invalid = call(
            &server,
            connection,
            json!({"jsonrpc":"2.0","id":3,"method":"channels/connect","params":{"type":"join","serverUrl":"http://public.example","credential":"a".repeat(64)}}),
        );
        assert_eq!(invalid["error"]["data"]["kind"], "ChannelInvalid");
        let disconnected = call(
            &server,
            connection,
            json!({"jsonrpc":"2.0","id":4,"method":"channels/disconnect","params":{}}),
        );
        assert!(disconnected.get("error").is_none());
    }
    initialize(&server, &mut untrusted);
    let denied = call(
        &server,
        &mut untrusted,
        json!({"jsonrpc":"2.0","id":2,"method":"channels/read","params":{}}),
    );
    assert_eq!(denied["error"]["data"]["kind"], "PermissionRequired");
    for (index, method) in ["channels/notes", "channels/call"].iter().enumerate() {
        let denied = call(
            &server,
            &mut untrusted,
            json!({"jsonrpc":"2.0","id":7 + index,"method":method,"params":{"spaceId":"a".repeat(64),"channelId":"b".repeat(64)}}),
        );
        assert_eq!(
            denied["error"]["data"]["kind"], "PermissionRequired",
            "{denied}"
        );
    }
    server.close_connection(first);
    let still_available = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0","id":5,"method":"channels/read","params":{}}),
    );
    assert!(still_available.get("error").is_none());
    server.close_connection(second);
    server.close_connection(browser);
    server.close_connection(untrusted);
}
