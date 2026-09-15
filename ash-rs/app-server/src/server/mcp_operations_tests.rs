use std::sync::Arc;
use std::sync::Mutex;

use ash_config::ConfigStore;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_mcp_extension::McpOAuthChallenge;
use ash_mcp_extension::McpOAuthCredential;
use ash_mcp_extension::McpOAuthCredentialReplacement;
use ash_mcp_extension::McpOAuthError;
use ash_mcp_extension::McpOAuthExchangeRequest;
use ash_mcp_extension::McpOAuthProvider;
use ash_mcp_extension::McpOAuthRefreshRequest;
use ash_mcp_extension::McpOAuthRevokeRequest;
use ash_mcp_extension::McpOAuthService;
use ash_mcp_extension::McpOAuthTarget;
use ash_model_provider::EchoModel;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretValue;
use serde_json::Value;
use url::Url;

use super::*;

#[derive(Default)]
struct TestOAuthProvider {
    refreshes: Mutex<usize>,
    revocations: Mutex<usize>,
    fail_revocation: Mutex<bool>,
}

impl McpOAuthProvider for TestOAuthProvider {
    fn authorization_url(
        &self,
        _: &McpOAuthTarget,
        challenge: McpOAuthChallenge<'_>,
    ) -> Result<String, McpOAuthError> {
        let mut url = Url::parse("https://accounts.example.test/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", challenge.state)
            .append_pair("code_challenge", challenge.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", challenge.redirect_uri)
            .append_pair("resource", challenge.resource.as_str());
        Ok(url.to_string())
    }

    fn exchange(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthExchangeRequest<'_>,
    ) -> Result<McpOAuthCredential, McpOAuthError> {
        assert_eq!(request.authorization_code.expose(), b"one-shot-code");
        Ok(McpOAuthCredential {
            runtime_secret: SecretValue::new(b"access-token".to_vec()),
            lifecycle_secret: SecretValue::new(b"refresh-token".to_vec()),
        })
    }

    fn refresh(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRefreshRequest<'_>,
    ) -> Result<McpOAuthCredentialReplacement, McpOAuthError> {
        assert_eq!(request.credential.expose(), b"refresh-token");
        *self.refreshes.lock().unwrap() += 1;
        Ok(McpOAuthCredentialReplacement {
            runtime_secret: SecretValue::new(b"refreshed-access-token".to_vec()),
            lifecycle_secret: SecretValue::new(b"refreshed-refresh-token".to_vec()),
        })
    }

    fn revoke(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRevokeRequest<'_>,
    ) -> Result<(), McpOAuthError> {
        assert_eq!(request.credential.expose(), b"refreshed-refresh-token");
        *self.revocations.lock().unwrap() += 1;
        if *self.fail_revocation.lock().unwrap() {
            return Err(McpOAuthError::new(
                ash_mcp_extension::McpOAuthErrorKind::ProviderFailure,
                "redacted provider failure",
            ));
        }
        Ok(())
    }
}

fn server() -> (AppServer, Arc<TestOAuthProvider>, tempfile::TempDir) {
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let provider = Arc::new(TestOAuthProvider::default());
    let provider_port: Arc<dyn McpOAuthProvider> = provider.clone();
    let server_id = McpServerId::new("user:mcp:calendar").unwrap();
    let oauth = Arc::new(McpOAuthService::new(
        Arc::new(MemorySecretStore::default()),
        [(server_id, provider_port)],
    ));
    let server = AppServer::new(
        threads,
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_config_store(config)
    .with_mcp_oauth_service(oauth);
    (server, provider, profile)
}

fn call(
    server: &AppServer,
    connection: &mut crate::server::ConnectionState,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}

fn initialize_and_configure(server: &AppServer, connection: &mut crate::server::ConnectionState) {
    let initialized = call(
        server,
        connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert_eq!(initialized["result"]["capabilities"]["mcpOAuth"], true);
    let configured = call(
        server,
        connection,
        2,
        "mcp/server/upsert",
        serde_json::json!({
            "commandId": "calendar-mcp",
            "expectedRevision": 0,
            "server": {
                "id": "user:mcp:calendar",
                "displayName": "Calendar",
                "transport": {"type": "streamableHttp", "url": "https://mcp.example.test/rpc"},
                "credential": {"type": "reference", "credentialRef": "user:credential:mcp-calendar"},
                "enablement": "enabled"
            }
        }),
    );
    assert_eq!(configured["result"]["revision"], 1);
}

#[test]
fn app_server_exposes_one_shot_mcp_oauth_and_reconciles_refresh_and_revoke() {
    let (server, provider, _profile) = server();
    let changes = server.mcp_runtime_intents.subscribe();
    let mut connection = server.connection();
    initialize_and_configure(&server, &mut connection);

    let invalid_redirect = call(
        &server,
        &mut connection,
        30,
        "mcp/oauth/start",
        serde_json::json!({
            "serverId": "user:mcp:calendar",
            "redirectUri": "http://remote.example.test/oauth/callback"
        }),
    );
    assert_eq!(invalid_redirect["error"]["message"], "InvalidParams");

    let started = call(
        &server,
        &mut connection,
        3,
        "mcp/oauth/start",
        serde_json::json!({
            "serverId": "user:mcp:calendar",
            "redirectUri": "http://127.0.0.1:43117/oauth/callback"
        }),
    );
    let authorization_url = started["result"]["authorizationUrl"].as_str().unwrap();
    let state = Url::parse(authorization_url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();
    let completed = call(
        &server,
        &mut connection,
        4,
        "mcp/oauth/complete",
        serde_json::json!({
            "flowId": started["result"]["flowId"],
            "state": state,
            "authorizationCode": "one-shot-code"
        }),
    );
    assert_eq!(completed["result"]["serverId"], "user:mcp:calendar");
    assert_eq!(changes.recv().unwrap(), ());

    let replayed = call(
        &server,
        &mut connection,
        5,
        "mcp/oauth/complete",
        serde_json::json!({
            "flowId": started["result"]["flowId"],
            "state": "wrong",
            "authorizationCode": "one-shot-code"
        }),
    );
    assert_eq!(replayed["error"]["message"], "McpOAuthInvalidCallback");

    let refreshed = call(
        &server,
        &mut connection,
        6,
        "mcp/oauth/refresh",
        serde_json::json!({"serverId": "user:mcp:calendar"}),
    );
    assert_eq!(refreshed["result"]["serverId"], "user:mcp:calendar");
    assert_eq!(*provider.refreshes.lock().unwrap(), 1);

    *provider.fail_revocation.lock().unwrap() = true;
    let failed_revoke = call(
        &server,
        &mut connection,
        7,
        "mcp/oauth/revoke",
        serde_json::json!({"serverId": "user:mcp:calendar"}),
    );
    assert_eq!(failed_revoke["error"]["message"], "McpOAuthOperationFailed");
    assert_eq!(
        server
            .mcp_runtime_intents
            .intent(&McpServerId::new("user:mcp:calendar").unwrap()),
        Some(McpServerRuntimeIntent::Disconnect)
    );

    *provider.fail_revocation.lock().unwrap() = false;
    let revoked = call(
        &server,
        &mut connection,
        8,
        "mcp/oauth/revoke",
        serde_json::json!({"serverId": "user:mcp:calendar"}),
    );
    assert_eq!(revoked["result"]["serverId"], "user:mcp:calendar");
    assert_eq!(*provider.revocations.lock().unwrap(), 2);
    assert_eq!(
        server
            .mcp_runtime_intents
            .intent(&McpServerId::new("user:mcp:calendar").unwrap()),
        Some(McpServerRuntimeIntent::Disconnect)
    );
}
