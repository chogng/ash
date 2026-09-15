use super::*;
use crate::local::ProviderModelService;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use ash_secrets::MemorySecretStore;
use connectors::ConnectorAuthority;
use connectors::ConnectorCredentialService;
use connectors::ConnectorDefinition;
use connectors::ConnectorDeviceOAuthGrant;
use connectors::ConnectorDeviceOAuthPoll;
use connectors::ConnectorDeviceOAuthPollRequest;
use connectors::ConnectorDeviceOAuthProvider;
use connectors::ConnectorDeviceOAuthService;
use connectors::ConnectorId;
use connectors::ConnectorOAuthChallenge;
use connectors::ConnectorOAuthCredential;
use connectors::ConnectorOAuthCredentialReplacement;
use connectors::ConnectorOAuthError;
use connectors::ConnectorOAuthExchangeRequest;
use connectors::ConnectorOAuthProvider;
use connectors::ConnectorOAuthRefreshRequest;
use connectors::ConnectorOAuthRevokeRequest;
use connectors::ConnectorOAuthService;
use connectors::ConnectorRuntimeBinding;
use std::sync::Arc;
use std::time::Duration;

fn server() -> AppServer {
    let connector = ConnectorDefinition::new(
        ConnectorId::new("acme/github:connector:account").unwrap(),
        "GitHub",
        "GitHub tools",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let service = Arc::new(ConnectorCredentialService::new(
        authority,
        Arc::new(MemorySecretStore::default()),
    ));
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_connector_service(service)
}

struct TestOAuthProvider;

impl ConnectorOAuthProvider for TestOAuthProvider {
    fn authorization_url(
        &self,
        _connector: &ConnectorDefinition,
        challenge: ConnectorOAuthChallenge<'_>,
    ) -> Result<String, ConnectorOAuthError> {
        let mut url = url::Url::parse("https://accounts.example.test/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", challenge.state)
            .append_pair("code_challenge", challenge.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", challenge.redirect_uri);
        Ok(url.to_string())
    }

    fn exchange(
        &self,
        _connector: &ConnectorDefinition,
        request: ConnectorOAuthExchangeRequest<'_>,
    ) -> Result<ConnectorOAuthCredential, ConnectorOAuthError> {
        assert_eq!(request.authorization_code.expose(), b"one-shot-code");
        Ok(ConnectorOAuthCredential {
            account_id: connectors::ConnectorAccountId::new("octocat").unwrap(),
            account_display_name: "Octocat".into(),
            runtime_secret: ash_secrets::SecretValue::new(b"provider-access-token".to_vec()),
            secret: ash_secrets::SecretValue::new(b"provider-access-token".to_vec()),
        })
    }

    fn refresh(
        &self,
        _connector: &ConnectorDefinition,
        request: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        Ok(ConnectorOAuthCredentialReplacement {
            runtime_secret: ash_secrets::SecretValue::new(b"provider-access-token".to_vec()),
            secret: request.credential,
        })
    }

    fn revoke(
        &self,
        _connector: &ConnectorDefinition,
        _request: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        Ok(())
    }
}

fn oauth_server() -> AppServer {
    let connector_id = ConnectorId::new("acme/github:connector:account").unwrap();
    let connector = ConnectorDefinition::new(
        connector_id.clone(),
        "GitHub",
        "GitHub tools",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let service = Arc::new(ConnectorCredentialService::new(
        authority,
        Arc::new(MemorySecretStore::default()),
    ));
    let provider: Arc<dyn ConnectorOAuthProvider> = Arc::new(TestOAuthProvider);
    let oauth = Arc::new(ConnectorOAuthService::new(
        Arc::clone(&service),
        [(connector_id, provider)],
    ));
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_connector_service(service)
    .with_connector_oauth_service(oauth)
}

struct TestDeviceOAuthProvider;

impl ConnectorDeviceOAuthProvider for TestDeviceOAuthProvider {
    fn start(
        &self,
        _: &ConnectorDefinition,
    ) -> Result<ConnectorDeviceOAuthGrant, ConnectorOAuthError> {
        Ok(ConnectorDeviceOAuthGrant {
            device_code: ash_secrets::SecretValue::new(b"device-secret".to_vec()),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://accounts.example.test/device".into(),
            expires_in: Duration::from_secs(60),
            poll_interval: Duration::from_millis(1),
        })
    }

    fn poll(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorDeviceOAuthPollRequest<'_>,
    ) -> Result<ConnectorDeviceOAuthPoll, ConnectorOAuthError> {
        assert_eq!(request.device_code.expose(), b"device-secret");
        Ok(ConnectorDeviceOAuthPoll::Complete(
            ConnectorOAuthCredential {
                account_id: connectors::ConnectorAccountId::new("octocat").unwrap(),
                account_display_name: "Octocat".into(),
                runtime_secret: ash_secrets::SecretValue::new(b"device-access-token".to_vec()),
                secret: ash_secrets::SecretValue::new(b"device-lifecycle".to_vec()),
            },
        ))
    }

    fn refresh(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        Ok(ConnectorOAuthCredentialReplacement {
            runtime_secret: ash_secrets::SecretValue::new(b"device-access-token".to_vec()),
            secret: request.credential,
        })
    }

    fn revoke(
        &self,
        _: &ConnectorDefinition,
        _: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        Ok(())
    }

    fn supports_remote_revoke(&self) -> bool {
        false
    }
}

fn device_oauth_server() -> AppServer {
    let connector_id = ConnectorId::new("acme/github:connector:account").unwrap();
    let connector = ConnectorDefinition::new(
        connector_id.clone(),
        "GitHub",
        "GitHub tools",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let service = Arc::new(ConnectorCredentialService::new(
        authority,
        Arc::new(MemorySecretStore::default()),
    ));
    let provider: Arc<dyn ConnectorDeviceOAuthProvider> = Arc::new(TestDeviceOAuthProvider);
    let oauth = Arc::new(ConnectorDeviceOAuthService::new(
        Arc::clone(&service),
        [(connector_id, provider)],
    ));
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_connector_service(service)
    .with_connector_device_oauth_service(oauth)
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

#[test]
fn app_server_connects_lists_notifies_and_disconnects_without_projecting_secrets() {
    let server = server();
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert!(initialized.get("result").is_some());
    assert_eq!(initialized["result"]["capabilities"]["connectors"], true);

    let listed = call(
        &server,
        &mut connection,
        2,
        "connector/list",
        serde_json::json!({}),
    );
    assert_eq!(listed["result"]["generation"], 1);
    assert_eq!(
        listed["result"]["connectors"][0]["state"]["status"],
        "disconnected"
    );

    let connected = call(
        &server,
        &mut connection,
        3,
        "connector/connect/apiToken",
        serde_json::json!({
            "commandId": "connect-github",
            "expectedGeneration": 1,
            "connectorId": "acme/github:connector:account",
            "connectionGeneration": 1,
            "accountId": "octocat",
            "accountDisplayName": "Octocat",
            "apiToken": "super-secret-token"
        }),
    );
    assert_eq!(connected["result"]["generation"], 3);
    assert_eq!(connected["result"]["disposition"], "updated");

    let connected_list = call(
        &server,
        &mut connection,
        4,
        "connector/list",
        serde_json::json!({}),
    );
    let serialized = connected_list.to_string();
    assert!(!serialized.contains("super-secret-token"));
    assert!(!serialized.contains("credentialReference"));
    assert_eq!(
        connected_list["result"]["connectors"][0]["state"]["status"],
        "connected"
    );

    let notifications = server.connection_notifications(&connection);
    let mut changed = Vec::new();
    for _ in 0..100 {
        changed.extend(notifications.drain());
        if changed.iter().any(|notification| {
            serde_json::from_str::<Value>(notification)
                .is_ok_and(|value| value["method"] == "connector/changed")
        }) {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(changed.iter().any(|notification| {
        serde_json::from_str::<Value>(notification)
            .is_ok_and(|value| value["method"] == "connector/changed")
    }));

    let disconnected = call(
        &server,
        &mut connection,
        5,
        "connector/disconnect",
        serde_json::json!({
            "commandId": "disconnect-github",
            "expectedGeneration": 3,
            "connectorId": "acme/github:connector:account"
        }),
    );
    assert_eq!(disconnected["result"]["command"]["generation"], 4);
    assert_eq!(disconnected["result"]["credentialCleanup"], "deleted");
}

#[test]
fn app_server_oauth_is_one_shot_and_projects_only_browser_navigation_values() {
    let server = oauth_server();
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    let listed = call(
        &server,
        &mut connection,
        2,
        "connector/list",
        serde_json::json!({}),
    );
    assert_eq!(
        listed["result"]["connectors"][0]["availableActions"],
        serde_json::json!(["connectOAuth"])
    );

    let started = call(
        &server,
        &mut connection,
        3,
        "connector/connect/oauth/start",
        serde_json::json!({
            "commandId": "oauth-github",
            "expectedGeneration": 1,
            "connectorId": "acme/github:connector:account",
            "connectionGeneration": 1,
            "redirectUri": "http://127.0.0.1:43117/oauth/callback"
        }),
    );
    let authorization_url = started["result"]["authorizationUrl"].as_str().unwrap();
    let parsed = url::Url::parse(authorization_url).unwrap();
    let state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let completed = call(
        &server,
        &mut connection,
        4,
        "connector/connect/oauth/complete",
        serde_json::json!({
            "flowId": started["result"]["flowId"],
            "state": &state,
            "authorizationCode": "one-shot-code"
        }),
    );
    assert_eq!(completed["result"]["generation"], 3);
    let serialized = call(
        &server,
        &mut connection,
        5,
        "connector/list",
        serde_json::json!({}),
    )
    .to_string();
    assert!(!serialized.contains("one-shot-code"));
    assert!(!serialized.contains("provider-access-token"));

    let replayed_callback = call(
        &server,
        &mut connection,
        6,
        "connector/connect/oauth/complete",
        serde_json::json!({
            "flowId": started["result"]["flowId"],
            "state": &state,
            "authorizationCode": "one-shot-code"
        }),
    );
    assert_eq!(replayed_callback["error"]["code"], -32038);
    assert_eq!(
        replayed_callback["error"]["message"],
        "ConnectorOAuthInvalidCallback"
    );
}

#[test]
fn app_server_device_oauth_projects_only_user_values_and_connects_after_poll() {
    let server = device_oauth_server();
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    let listed = call(
        &server,
        &mut connection,
        2,
        "connector/list",
        serde_json::json!({}),
    );
    assert_eq!(
        listed["result"]["connectors"][0]["oauthMethods"],
        serde_json::json!(["device"])
    );
    let started = call(
        &server,
        &mut connection,
        3,
        "connector/connect/oauth/device/start",
        serde_json::json!({
            "commandId": "device-github",
            "expectedGeneration": 1,
            "connectorId": "acme/github:connector:account",
            "connectionGeneration": 1
        }),
    );
    assert_eq!(started["result"]["userCode"], "ABCD-EFGH");
    assert_eq!(
        started["result"]["verificationUri"],
        "https://accounts.example.test/device"
    );
    let started_json = started.to_string();
    assert!(!started_json.contains("device-secret"));
    std::thread::sleep(Duration::from_millis(2));
    let polled = call(
        &server,
        &mut connection,
        4,
        "connector/connect/oauth/device/poll",
        serde_json::json!({"flowId": started["result"]["flowId"]}),
    );
    assert_eq!(polled["result"]["status"], "connected");
    let serialized = call(
        &server,
        &mut connection,
        5,
        "connector/list",
        serde_json::json!({}),
    )
    .to_string();
    assert!(!serialized.contains("device-access-token"));
    assert!(!serialized.contains("device-lifecycle"));
}

#[test]
fn app_server_device_oauth_cancel_consumes_the_flow_and_revokes_connecting_state() {
    let server = device_oauth_server();
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    let started = call(
        &server,
        &mut connection,
        2,
        "connector/connect/oauth/device/start",
        serde_json::json!({
            "commandId": "device-cancel",
            "expectedGeneration": 1,
            "connectorId": "acme/github:connector:account",
            "connectionGeneration": 1
        }),
    );
    let cancelled = call(
        &server,
        &mut connection,
        3,
        "connector/connect/oauth/device/cancel",
        serde_json::json!({"flowId": started["result"]["flowId"]}),
    );
    assert_eq!(cancelled["result"]["generation"], 3);
    let replay = call(
        &server,
        &mut connection,
        4,
        "connector/connect/oauth/device/cancel",
        serde_json::json!({"flowId": started["result"]["flowId"]}),
    );
    assert_eq!(replay["error"]["code"], -32038);
}
