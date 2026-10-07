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
fn github_device_flow_uses_public_client_protocol_and_projects_account() {
    let http = Arc::new(RecordingHttpClient {
        requests: Mutex::new(Vec::new()),
        responses: Mutex::new(
            [
                HttpResponse::new(
                    200,
                    Vec::new(),
                    br#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#.to_vec(),
                ),
                HttpResponse::new(
                    200,
                    Vec::new(),
                    br#"{"error":"authorization_pending"}"#.to_vec(),
                ),
                HttpResponse::new(
                    200,
                    Vec::new(),
                    br#"{"access_token":"gho_access","token_type":"bearer","scope":"repo"}"#.to_vec(),
                ),
                HttpResponse::new(
                    200,
                    Vec::new(),
                    br#"{"id":42,"login":"octocat","name":"The Octocat"}"#.to_vec(),
                ),
            ]
            .into_iter()
            .collect(),
        ),
    });
    let port: Arc<dyn HttpClient> = http.clone();
    let provider = GitHubDeviceOAuthProvider::new(
        GitHubDeviceOAuthConfig {
            client_id: "public-client".into(),
            scopes: vec!["repo".into()],
        },
        port,
    )
    .unwrap();
    let grant = provider.start(&definition()).unwrap();
    assert_eq!(grant.user_code, "ABCD-EFGH");
    assert!(matches!(
        provider
            .poll(
                &definition(),
                ConnectorDeviceOAuthPollRequest {
                    device_code: &grant.device_code,
                },
            )
            .unwrap(),
        ConnectorDeviceOAuthPoll::Pending
    ));
    let completed = provider
        .poll(
            &definition(),
            ConnectorDeviceOAuthPollRequest {
                device_code: &grant.device_code,
            },
        )
        .unwrap();
    let ConnectorDeviceOAuthPoll::Complete(credential) = completed else {
        panic!("expected completed credential");
    };
    assert_eq!(credential.account_id.as_str(), "42");
    assert_eq!(credential.runtime_secret.expose(), b"gho_access");
    let requests = http.requests.lock().unwrap();
    let token_body = std::str::from_utf8(requests[1].body()).unwrap();
    let token_fields = url::form_urlencoded::parse(token_body.as_bytes())
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        token_fields.get("grant_type").map(|value| value.as_ref()),
        Some("urn:ietf:params:oauth:grant-type:device_code")
    );
    assert!(!token_body.contains("client_secret"));
}

#[test]
fn github_slow_down_maps_to_generic_poll_control() {
    let http: Arc<dyn HttpClient> = Arc::new(RecordingHttpClient {
        requests: Mutex::new(Vec::new()),
        responses: Mutex::new(
            [HttpResponse::new(
                200,
                Vec::new(),
                br#"{"error":"slow_down"}"#.to_vec(),
            )]
            .into_iter()
            .collect(),
        ),
    });
    let provider = GitHubDeviceOAuthProvider::new(
        GitHubDeviceOAuthConfig {
            client_id: "public-client".into(),
            scopes: Vec::new(),
        },
        http,
    )
    .unwrap();
    assert!(matches!(
        provider
            .poll(
                &definition(),
                ConnectorDeviceOAuthPollRequest {
                    device_code: &SecretValue::new(b"device".to_vec()),
                },
            )
            .unwrap(),
        ConnectorDeviceOAuthPoll::SlowDown
    ));
}
