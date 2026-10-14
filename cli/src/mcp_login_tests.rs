use super::*;
#[test]
fn callback_preserves_issuer_and_rejects_duplicate_fields_or_wrong_paths() {
    let redirect = "http://127.0.0.1:12345/mcp-oauth/test";
    let path = "/mcp-oauth/test";
    assert_eq!(
        callback(
            "GET /mcp-oauth/test?state=s&code=c&iss=https%3A%2F%2Fissuer.test HTTP/1.1\r\n\r\n",
            redirect,
            path
        ),
        Some(("s".into(), "c".into(), Some("https://issuer.test".into())))
    );
    for request in [
        "GET /mcp-oauth/test?state=s&code=c HTTP/1.1\r\n",
        "GET /wrong?state=s&code=c HTTP/1.1\r\n\r\n",
        "GET /mcp-oauth/test?state=s&state=x&code=c HTTP/1.1\r\n\r\n",
        "POST /mcp-oauth/test?state=s&code=c HTTP/1.1\r\n\r\n",
        "GET /mcp-oauth/test?state=s&error=denied HTTP/1.1\r\n\r\n",
        "GET //evil.test/mcp-oauth/test?state=s&code=c HTTP/1.1\r\n\r\n",
    ] {
        assert!(callback(request, redirect, path).is_none());
    }
}

#[test]
fn cli_sign_in_uses_a_real_loopback_callback_and_completes_through_the_typed_client() {
    struct Backend {
        callbacks: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }
    impl ash_app_server_client::JsonRpcTransport for Backend {
        fn round_trip(
            &mut self,
            request: &str,
        ) -> Result<String, ash_app_server_client::ClientError> {
            let request: serde_json::Value = serde_json::from_str(request).unwrap();
            let result = match request["method"].as_str().unwrap() {
                "mcp/oauth/start" => {
                    serde_json::json!({"flowId":"flow","authorizationUrl":"https://issuer.test/authorize"})
                }
                "mcp/oauth/complete" => {
                    self.callbacks
                        .lock()
                        .unwrap()
                        .push(request["params"].clone());
                    serde_json::json!({"serverId":"user:mcp:test"})
                }
                other => panic!("unexpected method {other}"),
            };
            Ok(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let callback = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let mut client = ash_app_server_client::AppServerClient::new(Backend {
        callbacks: callback.clone(),
    });
    let interrupt = InterruptSignal::register().unwrap();
    let params = McpOAuthStartParams {
        server_id: "user:mcp:test".into(),
        redirect_uri: format!("http://{address}/mcp-oauth/callback"),
        client_id: None,
        client_metadata_url: None,
        scopes: vec![],
    };
    let mut browser = None;
    sign_in(&mut client,params,&listener,&interrupt,|url| {
        assert_eq!(url,"https://issuer.test/authorize");
        browser=Some(std::thread::spawn(move || {
            let mut incomplete = std::net::TcpStream::connect(address).unwrap();
            incomplete.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            incomplete.write_all(b"GET /mcp-oauth/callback?state=state&code=code HTTP/1.1\r\n").unwrap();
            incomplete.shutdown(std::net::Shutdown::Write).unwrap();
            let mut rejected = String::new();
            incomplete.read_to_string(&mut rejected).unwrap();
            assert!(rejected.starts_with("HTTP/1.1 400"));
            let mut stream=std::net::TcpStream::connect(address).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            stream.write_all(b"GET /mcp-oauth/callback?state=state&code=code&iss=https%3A%2F%2Fissuer.test HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut response=String::new(); stream.read_to_string(&mut response).unwrap(); assert!(response.starts_with("HTTP/1.1 200"));
        }));
    }).unwrap();
    browser.unwrap().join().unwrap();
    assert_eq!(
        *callback.lock().unwrap(),
        vec![
            serde_json::json!({"flowId":"flow","state":"state","authorizationCode":"code","issuer":"https://issuer.test"})
        ]
    );
}
