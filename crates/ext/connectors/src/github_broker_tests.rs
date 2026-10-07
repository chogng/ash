use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;

use super::*;

struct RecordingHttpClient {
    requests: Mutex<Vec<HttpRequest>>,
    responses: Mutex<VecDeque<HttpResponse>>,
}

impl HttpClient for RecordingHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| HttpClientError::Transport("missing response".into()))
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

#[test]
fn brokered_pkce_keeps_confidential_secret_out_of_client_and_returns_account() {
    let http = Arc::new(RecordingHttpClient {
        requests: Mutex::new(Vec::new()),
        responses: Mutex::new(
            [HttpResponse::new(
                200,
                Vec::new(),
                br#"{"access_token":"gho_access","refresh_token":"ghr_refresh","token_type":"bearer","scope":"repo","account_id":"42","account_display_name":"Octocat"}"#.to_vec(),
            )]
            .into_iter()
            .collect(),
        ),
    });
    let port: Arc<dyn HttpClient> = http.clone();
    let provider = GitHubBrokeredOAuthProvider::new(
        GitHubBrokeredOAuthConfig {
            broker_base_url: Url::parse("https://oauth.ash.example/").unwrap(),
            client_id: "public-client".into(),
            scopes: vec!["repo".into()],
        },
        port,
    )
    .unwrap();
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
    assert!(authorization.starts_with("https://oauth.ash.example/v1/oauth/github/authorize?"));
    let credential = provider
        .exchange(
            &definition(),
            ConnectorOAuthExchangeRequest {
                authorization_code: SecretValue::new(b"one-shot-code".to_vec()),
                pkce_verifier: "verifier",
                redirect_uri: "http://127.0.0.1:49152/callback",
            },
        )
        .unwrap();
    assert_eq!(credential.account_id.as_str(), "42");
    assert_eq!(credential.runtime_secret.expose(), b"gho_access");
    let requests = http.requests.lock().unwrap();
    let body = std::str::from_utf8(requests[0].body()).unwrap();
    assert!(body.contains("code_verifier=verifier"));
    assert!(!body.contains("client_secret"));
}

#[test]
fn broker_base_url_requires_an_unambiguous_https_directory() {
    let http: Arc<dyn HttpClient> = Arc::new(RecordingHttpClient {
        requests: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::new()),
    });
    let configuration = |url: &str| GitHubBrokeredOAuthConfig {
        broker_base_url: Url::parse(url).unwrap(),
        client_id: "public-client".into(),
        scopes: vec!["repo".into()],
    };

    assert!(
        GitHubBrokeredOAuthProvider::new(
            configuration("https://oauth.ash.example/base"),
            Arc::clone(&http),
        )
        .is_err()
    );
    assert!(
        GitHubBrokeredOAuthProvider::new(
            configuration("https://user@oauth.ash.example/"),
            Arc::clone(&http),
        )
        .is_err()
    );
    assert!(
        GitHubBrokeredOAuthProvider::new(configuration("http://oauth.ash.example/"), http,)
            .is_err()
    );
}
