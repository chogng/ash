use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use ash_config::McpCredentialBinding;
use ash_config::McpServerConfig;
use ash_config::McpServerEnablement;
use ash_config::McpServerId;
use ash_config::McpTransportConfig;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use url::Url;

use super::*;

#[derive(Default)]
struct TestProvider {
    verifier: Mutex<Option<String>>,
    refreshes: Mutex<usize>,
    revocations: Mutex<usize>,
    fail_revocation: Mutex<bool>,
}

impl McpOAuthProvider for TestProvider {
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
        assert_eq!(request.authorization_code.expose(), b"authorization-code");
        assert_eq!(request.redirect_uri, "http://127.0.0.1:49152/callback");
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
        *self.verifier.lock().unwrap() = Some(request.pkce_verifier.to_string());
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
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
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
        assert!(matches!(
            request.credential.expose(),
            b"refresh-token" | b"refreshed-refresh-token"
        ));
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
        *self.revocations.lock().unwrap() += 1;
        if *self.fail_revocation.lock().unwrap() {
            return Err(McpOAuthError::new(
                McpOAuthErrorKind::ProviderFailure,
                "redacted provider failure",
            ));
        }
        Ok(())
    }
}

fn config(endpoint: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId::new("user:mcp:calendar").unwrap(),
        display_name: "Calendar".into(),
        transport: McpTransportConfig::StreamableHttp {
            url: endpoint.into(),
        },
        credential: McpCredentialBinding::Reference {
            credential_ref: "user:credential:mcp-calendar".into(),
        },
        enablement: McpServerEnablement::Enabled,
    }
}

fn fixture() -> (
    McpOAuthService,
    McpOAuthTarget,
    Arc<MemorySecretStore>,
    Arc<TestProvider>,
) {
    let target = McpOAuthTarget::from_config(&config("https://mcp.example.test/rpc")).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let provider = Arc::new(TestProvider::default());
    let provider_port: Arc<dyn McpOAuthProvider> = provider.clone();
    let oauth = McpOAuthService::new(
        secrets.clone(),
        [(target.server_id().clone(), provider_port)],
    );
    (oauth, target, secrets, provider)
}

fn callback_state(authorization_url: &str) -> SecretValue {
    let url = Url::parse(authorization_url).unwrap();
    let state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();
    SecretValue::new(state.into_bytes())
}

#[test]
fn oauth_pkce_callback_stores_an_envelope_but_projects_only_the_runtime_token() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    assert_eq!(
        oauth.pending_server_id(&authorization.flow_id),
        Some(target.server_id().clone())
    );
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();

    let stored = secrets.load(target.credential_key()).unwrap().unwrap();
    assert_ne!(stored.expose(), b"access-token");
    assert_eq!(
        project_runtime_credential(stored).unwrap().expose(),
        b"access-token"
    );
    assert_eq!(
        provider.verifier.lock().unwrap().as_ref().unwrap().len(),
        43
    );
}

#[test]
fn callback_rejects_a_target_changed_while_the_browser_flow_was_open() {
    let (oauth, target, secrets, _) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            target,
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    let changed = McpOAuthTarget::from_config(&config("https://mcp.example.test/changed")).unwrap();
    let error = oauth
        .complete(McpOAuthCompleteRequest {
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: changed.clone(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), McpOAuthErrorKind::InvalidRequest);
    assert!(secrets.load(changed.credential_key()).unwrap().is_none());
}

#[test]
fn refresh_rotates_both_credential_parts_and_revoke_deletes_the_envelope() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();

    oauth.refresh(&target).unwrap();
    let stored = secrets.load(target.credential_key()).unwrap().unwrap();
    assert_eq!(
        project_runtime_credential(stored).unwrap().expose(),
        b"refreshed-access-token"
    );
    assert_eq!(*provider.refreshes.lock().unwrap(), 1);

    assert_eq!(oauth.revoke(&target).unwrap(), DeleteSecretOutcome::Deleted);
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
    assert_eq!(*provider.revocations.lock().unwrap(), 1);
}

#[test]
fn raw_bearer_credentials_remain_backward_compatible() {
    let credential = SecretValue::new(b"existing-bearer".to_vec());
    assert_eq!(
        project_runtime_credential(credential).unwrap().expose(),
        b"existing-bearer"
    );
}

#[test]
fn failed_remote_revoke_keeps_the_local_lifecycle_credential_for_retry() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();
    *provider.fail_revocation.lock().unwrap() = true;

    let error = oauth.revoke(&target).unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::ProviderFailure);
    assert!(secrets.load(target.credential_key()).unwrap().is_some());
}

#[test]
fn expired_flow_keeps_its_target_available_for_typed_callback_expiry() {
    let (oauth, target, _, _) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .pending
        .lock()
        .unwrap()
        .get_mut(&authorization.flow_id)
        .unwrap()
        .started_at = Instant::now() - FLOW_LIFETIME - Duration::from_secs(1);

    assert_eq!(
        oauth.pending_server_id(&authorization.flow_id),
        Some(target.server_id().clone())
    );
    let error = oauth
        .complete(McpOAuthCompleteRequest {
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target,
        })
        .unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::Expired);
}

#[test]
fn pending_oauth_flows_are_bounded() {
    let (oauth, target, _, _) = fixture();
    for _ in 0..MAX_PENDING_OAUTH_FLOWS {
        oauth
            .start(McpOAuthStartRequest {
                target: target.clone(),
                redirect_uri: "http://127.0.0.1:49152/callback".into(),
            })
            .unwrap();
    }

    let error = oauth
        .start(McpOAuthStartRequest {
            target,
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::ProviderFailure);
}
