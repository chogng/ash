use super::*;
use ash_http_client::HttpClientError;

#[derive(Default)]
struct FixtureHttp {
    calls: Mutex<Vec<(String, String)>>,
}
impl HttpClient for FixtureHttp {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        assert!(request.rejects_redirects());
        let body = String::from_utf8_lossy(request.body()).to_string();
        self.calls
            .lock()
            .unwrap()
            .push((request.url().to_owned(), body.clone()));
        let response = match request.url() {
            "https://mcp.example.test/rpc" => {
                return Ok(HttpResponse::new(
                    401,
                    vec![HttpHeader::new(
                        "WWW-Authenticate",
                        "Bearer resource_metadata=\"https://mcp.example.test/metadata\", scope=\"read\"",
                    )],
                    Vec::new(),
                ));
            }
            "https://mcp.example.test/metadata" => {
                serde_json::json!({"resource":"https://mcp.example.test/rpc", "authorization_servers":["https://issuer.example.test"], "scopes_supported":["read", "write"]})
            }
            "https://issuer.example.test/.well-known/oauth-authorization-server" => {
                serde_json::json!({"issuer":"https://issuer.example.test", "authorization_endpoint":"https://issuer.example.test/authorize", "token_endpoint":"https://issuer.example.test/token", "registration_endpoint":"https://issuer.example.test/register", "revocation_endpoint":"https://issuer.example.test/revoke", "code_challenge_methods_supported":["S256"], "authorization_response_iss_parameter_supported":true})
            }
            "https://issuer.example.test/register" => serde_json::json!({"client_id":"ash-client"}),
            "https://issuer.example.test/token" if body.contains("grant_type=refresh_token") => {
                serde_json::json!({"access_token":"fresh", "refresh_token":"rotated", "token_type":"Bearer", "expires_in":3600})
            }
            "https://issuer.example.test/token" => {
                serde_json::json!({"access_token":"access", "refresh_token":"refresh", "token_type":"Bearer", "expires_in":0})
            }
            "https://issuer.example.test/revoke" => serde_json::json!({}),
            _ => panic!("unexpected endpoint"),
        };
        Ok(HttpResponse::new(
            200,
            vec![],
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

fn target() -> McpOAuthTarget {
    McpOAuthTarget::from_config(&ash_config::McpServerConfig {
        id: ash_config::McpServerId::new("user:mcp:test").unwrap(),
        display_name: "Test".into(),
        transport: ash_config::McpTransportConfig::StreamableHttp {
            url: "https://mcp.example.test/rpc".into(),
        },
        credential: ash_config::McpCredentialBinding::Reference {
            credential_ref: "mcp/test".into(),
        },
        enablement: ash_config::McpServerEnablement::Enabled,
    })
    .unwrap()
}

#[test]
fn standard_oauth_discovers_registers_binds_issuer_rotates_and_revokes() {
    let http = Arc::new(FixtureHttp::default());
    let provider = HttpOAuthProvider::new(http.clone());
    let target = target();
    let verifier = "test-verifier";
    let url = provider
        .authorization_url(
            &target,
            McpOAuthChallenge {
                options: &McpOAuthOptions::default(),
                state: "state",
                code_challenge: &pkce_challenge(verifier),
                redirect_uri: "http://127.0.0.1:3333/callback",
                resource: target.endpoint(),
            },
        )
        .unwrap();
    let parsed = Url::parse(&url).unwrap();
    assert!(
        parsed
            .query_pairs()
            .any(|(k, v)| k == "scope" && v == "read")
    );
    let credential = provider
        .exchange(
            &target,
            McpOAuthExchangeRequest {
                issuer: Some("https://issuer.example.test"),
                authorization_code: SecretValue::new(b"code".to_vec()),
                pkce_verifier: verifier,
                redirect_uri: "http://127.0.0.1:3333/callback",
                resource: target.endpoint(),
            },
        )
        .unwrap();
    assert!(
        provider
            .needs_refresh(&credential.lifecycle_secret)
            .unwrap()
    );
    let refreshed = provider
        .refresh(
            &target,
            McpOAuthRefreshRequest {
                credential: credential.lifecycle_secret,
                resource: target.endpoint(),
            },
        )
        .unwrap();
    assert_eq!(refreshed.runtime_secret.expose(), b"fresh");
    let tokens: Tokens = serde_json::from_slice(refreshed.lifecycle_secret.expose()).unwrap();
    assert_eq!(tokens.refresh_token.as_deref(), Some("rotated"));
    provider
        .revoke(
            &target,
            McpOAuthRevokeRequest {
                credential: refreshed.lifecycle_secret,
                resource: target.endpoint(),
            },
        )
        .unwrap();
    let calls = http.calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .filter(|(url, _)| url.ends_with("/token"))
            .all(|(_, body)| body.contains("resource=https%3A%2F%2Fmcp.example.test%2Frpc"))
    );
    assert!(calls.last().unwrap().1.contains("token=rotated"));
}

#[test]
fn issuer_mismatch_never_exchanges_the_code() {
    let http = Arc::new(FixtureHttp::default());
    let provider = HttpOAuthProvider::new(http.clone());
    let target = target();
    for issuer in [None, Some("https://evil.test")] {
        provider
            .authorization_url(
                &target,
                McpOAuthChallenge {
                    options: &McpOAuthOptions::default(),
                    state: "state",
                    code_challenge: &pkce_challenge("v"),
                    redirect_uri: "http://127.0.0.1/callback",
                    resource: target.endpoint(),
                },
            )
            .unwrap();
        assert!(
            provider
                .exchange(
                    &target,
                    McpOAuthExchangeRequest {
                        issuer,
                        authorization_code: SecretValue::new(b"code".to_vec()),
                        pkce_verifier: "v",
                        redirect_uri: "http://127.0.0.1/callback",
                        resource: target.endpoint()
                    }
                )
                .is_err()
        );
    }
    assert!(
        !http
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(url, _)| url.ends_with("/token"))
    );
}

#[test]
fn changing_the_endpoint_never_exposes_an_unexpired_token_to_the_new_server() {
    let http = Arc::new(FixtureHttp::default());
    let provider = HttpOAuthProvider::new(http);
    let target = target();
    let lifecycle = SecretValue::new(
        serde_json::to_vec(&Tokens {
            registration: Registration {
                issuer: "https://issuer.example.test".into(),
                require_issuer: false,
                token_endpoint: "https://issuer.example.test/token".into(),
                revocation_endpoint: None,
                client_id: "client".into(),
                client_secret: None,
                resource: target.endpoint().to_string(),
                scopes: vec![],
            },
            refresh_token: Some("refresh".into()),
            expires_at: Some(u64::MAX),
        })
        .unwrap(),
    );
    provider.validate_credential(&target, &lifecycle).unwrap();
    let mut changed = target;
    changed.endpoint = Url::parse("https://other.example.test/rpc").unwrap();
    assert_eq!(
        provider
            .validate_credential(&changed, &lifecycle)
            .unwrap_err()
            .kind(),
        McpOAuthErrorKind::ReauthenticationRequired
    );
}
