use super::*;

#[test]
fn remote_catalog_preserves_each_session_root_and_deduplicates_host_views() {
    let index: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::new()));
    let key = ("build-host".to_owned(), "/work/first".to_owned());
    let mut remote = serde_json::json!({
        "jsonrpc":"2.0", "id":catalog_request_id(1),
        "result":{"sessions":[
            {"sessionId":"one","threads":[{"threadId":"thread-one"}],"workspace":{"type":"local","root":"/work/first"}},
            {"sessionId":"two","threads":[{"threadId":"thread-two"}],"workspace":{"type":"local","root":"/work/second"}}
        ]}
    });
    annotate_remote_sessions(&mut remote, &key, &index);
    assert_eq!(
        remote["result"]["sessions"][1]["workspace"],
        serde_json::json!({"type":"ssh","host":"build-host","root":"/work/second"})
    );
    assert_eq!(
        index.lock().unwrap().get("thread-two"),
        Some(&("build-host".into(), "/work/second".into()))
    );

    let catalogs: Catalogs = Arc::new(Mutex::new(BTreeMap::from([(
        1,
        PendingCatalog {
            response: serde_json::json!({"jsonrpc":"2.0","id":7,"result":{"sessions":[]}}),
            remaining: 2,
        },
    )])));
    let (outbound, received) = mpsc::channel();
    complete_catalog(&catalogs, 1, remote.clone(), &outbound);
    assert!(received.try_recv().is_err());
    complete_catalog(&catalogs, 1, remote, &outbound);
    let merged: Value = serde_json::from_str(&received.recv().unwrap()).unwrap();
    assert_eq!(merged["result"]["sessions"].as_array().unwrap().len(), 2);
}

#[test]
fn host_request_route_restores_the_issuing_server_id() {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "browser-host:1:2",
        "method": "browser/open",
        "params": {}
    });
    let tagged = tag_host_request(request.to_string(), 5);
    let tagged: Value = serde_json::from_str(&tagged).unwrap();
    let response = serde_json::json!({"jsonrpc":"2.0","id":tagged["id"],"result":{}});
    let (route, original) = untag_host_response(&response).unwrap();
    assert_eq!(route, 5);
    assert_eq!(original["id"], "browser-host:1:2");
}
