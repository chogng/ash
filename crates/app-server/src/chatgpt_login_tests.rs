use super::*;

#[test]
fn chatgpt_login_entries_are_independent_in_local_app_server() {
    struct NoRequests;
    impl OperationClient for NoRequests {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            panic!("starting and cancelling a browser grant must not exchange credentials");
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let codex_home = tempfile::tempdir().unwrap();
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(codex_home.path())
            .with_model_operation_client(Arc::new(NoRequests))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let mut connection = server.connection();
    local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"clientInfo":{"name":"chatgpt-isolation","version":"1"},"capabilities":{}}
        }),
    );
    let independent = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":2, "method":"account/login/start",
            "params":{"method":{"type":"chatGptPlanBrowser","accountId":null}}
        }),
    );
    assert_eq!(independent["result"]["type"], "browser");
    let url = url::Url::parse(independent["result"]["authorizationUrl"].as_str().unwrap()).unwrap();
    let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "dynamic_agent_client");
    assert_eq!(query["resource"], "https://api.openai.com/v1");
    let local = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":3, "method":"account/login/start",
            "params":{"method":{"type":"openAiChatGptDeviceCode"}}
        }),
    );
    assert_eq!(
        local["error"]["data"]["kind"],
        "AccountExternalLoginRequired"
    );
    // A failed local reconnection must leave the other provider's pending grant alive.
    let cancelled = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"account/login/cancel",
            "params":{"loginId":independent["result"]["loginId"]}
        }),
    );
    assert_eq!(cancelled["result"]["status"], "cancelled");
    // The embedded/TUI composition does not opt into a product extension.
    let github = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"account/login/start","params":{"method":{"type":"gitHubBrowser"}}
        }),
    );
    assert_eq!(github["error"]["data"]["kind"], "AccountUnavailable");
    assert!(!codex_home.path().join("auth.json").exists());
    let providers = local_call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0", "id":5, "method":"provider/list", "params":{}}),
    );
    for connection in ["chatgpt-subscription", "chatgpt-plan"] {
        let entry = providers["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["connection"] == connection)
            .unwrap();
        assert_eq!(entry["ready"], false);
        assert_eq!(entry["active"], false);
    }
}

fn web_jwt(value: serde_json::Value) -> String {
    use base64::Engine;
    format!(
        "e30.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap())
    )
}

#[test]
fn independent_web_cold_profile_uses_one_owner_before_native_authorization() {
    const FIXTURE: &str = "ASH_TEST_CHATGPT_WEB_COLD_PROFILE";
    if let Ok(root) = std::env::var(FIXTURE) {
        struct Refresh(std::sync::atomic::AtomicUsize);
        impl OperationClient for Refresh {
            fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
                assert_eq!(request.url(), "https://auth.openai.com/oauth/token");
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(ClientResponse::new(200, vec![], serde_json::to_vec(&serde_json::json!({"access_token":web_jwt(serde_json::json!({"exp":4_000_000_000_u64,"jti":"renewed-by-web-owner"})),"refresh_token":"rotated-private-refresh"})).unwrap()))
            }
        }
        let root = Path::new(&root);
        let runtime = Arc::new(LocalProfileRuntime::open(root.join("profile")).unwrap());
        let client = Arc::new(Refresh(std::sync::atomic::AtomicUsize::new(0)));
        let open = |dir: &Path| {
            open_app_server(
                AppServerOptions::new(root.join("profile"))
                    .with_profile_runtime(runtime.clone())
                    .with_dir_root(dir)
                    .with_codex_home(root.join("codex"))
                    .with_model_operation_client(client.clone())
                    .without_built_in_skills(),
                ash_app_server_diff::compute,
            )
            .unwrap()
        };
        let first = open(&root.join("first"));
        let authority = runtime.chatgpt_web.lock().unwrap().clone().unwrap();
        let second = open(&root.join("second"));
        assert!(Arc::ptr_eq(
            &authority,
            runtime.chatgpt_web.lock().unwrap().as_ref().unwrap()
        ));
        let expected =
            web_jwt(serde_json::json!({"exp":4_000_000_000_u64,"jti":"renewed-by-web-owner"}));
        for server in [first, second] {
            use std::io::BufRead;
            use std::io::Write;
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let client_stream =
                std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            client_stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let (stream, _) = listener.accept().unwrap();
            let worker = std::thread::spawn(move || {
                server
                    .serve_host_credentials(
                        std::io::BufReader::new(stream.try_clone().unwrap()),
                        stream,
                    )
                    .unwrap()
            });
            let mut reader = std::io::BufReader::new(client_stream.try_clone().unwrap());
            let mut writer = client_stream;
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(ready["kind"], "ready");
            for request in ["aaaa", "bbbb", "cccc", "dddd"] {
                writeln!(writer, "{}", serde_json::json!({"kind":"authorize","requestId":request,"context":ready["context"]})).unwrap();
                line.clear();
                reader.read_line(&mut line).unwrap();
                let authorized: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(authorized["kind"], "authorized");
                assert_eq!(
                    authorized["headers"]["Authorization"],
                    format!("Bearer {expected}")
                );
            }
            drop(reader);
            drop(writer);
            worker.join().unwrap();
        }
        assert_eq!(
            client.0.load(std::sync::atomic::Ordering::SeqCst),
            if std::env::var("ASH_TEST_CHATGPT_WEB_REOPEN").as_deref() == Ok("1") {
                0
            } else {
                1
            }
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    for dir in ["first", "second", "codex"] {
        std::fs::create_dir(root.path().join(dir)).unwrap();
    }
    let external = b"external Codex fixture must remain untouched";
    std::fs::write(root.path().join("codex/auth.json"), external).unwrap();
    {
        let runtime = LocalProfileRuntime::open(root.path().join("profile")).unwrap();
        let value = serde_json::json!({"auth_mode":"chatgpt","_ash_source":"ash","_ash_generation":1,"last_refresh":"2026-10-30T00:00:00Z","tokens":{"id_token":web_jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"private-user","chatgpt_account_id":"private-account"}})),"access_token":web_jwt(serde_json::json!({"exp":1})),"refresh_token":"private-refresh","account_id":"private-account"}});
        runtime
            .secret_store()
            .store(
                &ash_secrets::SecretKey::new("provider/chatgpt-web/credentials-v1").unwrap(),
                &ash_secrets::SecretValue::new(serde_json::to_vec(&value).unwrap()),
            )
            .unwrap();
    }
    // A second OS process cannot succeed using the first process's in-memory tokens.
    for reopen in ["0", "1"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local::tests::chatgpt_login::independent_web_cold_profile_uses_one_owner_before_native_authorization", "--nocapture"])
            .env(FIXTURE, root.path()).env("ASH_TEST_CHATGPT_WEB_REOPEN", reopen)
            .env("ASH_USE_INMEMORY_SECRETSTORAGE", "0").env("ASH_USE_DEVELOPMENT_SECRETSTORAGE", "0")
            .output().unwrap();
        assert!(
            output.status.success(),
            "cold profile process failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        assert_eq!(
            std::fs::read(root.path().join("codex/auth.json")).unwrap(),
            external
        );
    }
}
