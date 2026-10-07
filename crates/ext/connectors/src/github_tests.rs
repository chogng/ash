use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_secrets::SecretValue;

use super::GitHubOAuthConfig;
use super::GitHubOAuthProvider;
use crate::ConnectorOAuthChallenge;
use crate::ConnectorOAuthExchangeRequest;
use crate::ConnectorOAuthProvider;
use crate::ConnectorOAuthRefreshRequest;
use crate::ConnectorOAuthRevokeRequest;

struct RecordingHttpClient {
    requests: Mutex<Vec<HttpRequest>>,
    responses: Mutex<VecDeque<HttpResponse>>,
}

impl RecordingHttpClient {
    fn new(responses: impl IntoIterator<Item = HttpResponse>) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(responses.into_iter().collect()),
        }
    }
}

impl HttpClient for RecordingHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| HttpClientError::Transport("missing test response".into()))
    }
}

fn definition() -> ConnectorDefinition {
    ConnectorDefinition::new(
        ConnectorId::new("acme/github:connector:account").unwrap(),
        "GitHub",
        "Connect GitHub.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap()
}

fn provider(
    responses: impl IntoIterator<Item = HttpResponse>,
) -> (GitHubOAuthProvider, Arc<RecordingHttpClient>) {
    let http = Arc::new(RecordingHttpClient::new(responses));
    let port: Arc<dyn HttpClient> = http.clone();
    let provider = GitHubOAuthProvider::new(
        GitHubOAuthConfig {
            client_id: "client-id".into(),
            client_secret: SecretValue::new(b"client-secret".to_vec()),
            scopes: vec!["read:user".into(), "repo".into()],
        },
        port,
    )
    .unwrap();
    (provider, http)
}

#[test]
fn authorization_and_exchange_use_pkce_and_publish_provider_account_identity() {
    let (provider, http) = provider([
        HttpResponse::new(
            200,
            Vec::new(),
            br#"{"access_token":"gho_access","refresh_token":"ghr_refresh","expires_in":28800,"refresh_token_expires_in":15897600,"token_type":"bearer","scope":"read:user repo"}"#.to_vec(),
        ),
        HttpResponse::new(
            200,
            Vec::new(),
            br#"{"id":42,"login":"octocat","name":"The Octocat"}"#.to_vec(),
        ),
    ]);
    let authorization = provider
        .authorization_url(
            &definition(),
            ConnectorOAuthChallenge {
                state: "state",
                code_challenge: "challenge",
                redirect_uri: "http://127.0.0.1:49152/callback",
            },
        )
        .unwrap();
    assert!(authorization.contains("code_challenge=challenge"));
    assert!(authorization.contains("scope=read%3Auser+repo"));

    let credential = provider
        .exchange(
            &definition(),
            ConnectorOAuthExchangeRequest {
                authorization_code: SecretValue::new(b"code".to_vec()),
                pkce_verifier: "verifier",
                redirect_uri: "http://127.0.0.1:49152/callback",
            },
        )
        .unwrap();

    assert_eq!(credential.account_id.as_str(), "42");
    assert_eq!(credential.account_display_name, "The Octocat");
    let requests = http.requests.lock().unwrap();
    let body = std::str::from_utf8(requests[0].body()).unwrap();
    assert!(body.contains("code_verifier=verifier"));
    assert!(!format!("{:?}", requests[0].headers()).contains("client-secret"));
}

#[test]
fn refresh_rotates_the_complete_secret_bundle_and_revoke_deletes_the_access_token() {
    let (provider, http) = provider([
        HttpResponse::new(
            200,
            Vec::new(),
            br#"{"access_token":"gho_new","refresh_token":"ghr_new","token_type":"bearer","scope":"repo"}"#.to_vec(),
        ),
        HttpResponse::new(204, Vec::new(), Vec::new()),
    ]);
    let old = SecretValue::new(
        br#"{"schema_version":1,"access_token":"gho_old","refresh_token":"ghr_old","expires_in":1,"refresh_token_expires_in":2,"token_type":"bearer","scope":"repo"}"#.to_vec(),
    );
    let refreshed = provider
        .refresh(
            &definition(),
            ConnectorOAuthRefreshRequest { credential: old },
        )
        .unwrap();
    let refreshed_json: serde_json::Value =
        serde_json::from_slice(refreshed.secret.expose()).unwrap();
    assert_eq!(refreshed_json["access_token"], "gho_new");
    assert_eq!(refreshed.runtime_secret.expose(), b"gho_new");

    provider
        .revoke(
            &definition(),
            ConnectorOAuthRevokeRequest {
                credential: refreshed.secret,
            },
        )
        .unwrap();

    let requests = http.requests.lock().unwrap();
    assert_eq!(requests[1].method(), HttpMethod::Delete);
    assert_eq!(
        requests[1].url(),
        "https://api.github.com/applications/client-id/token"
    );
    assert!(requests[1].headers().iter().any(|header| {
        header.name() == "Authorization" && header.value().starts_with("Basic ")
    }));
}
