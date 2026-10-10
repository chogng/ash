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
