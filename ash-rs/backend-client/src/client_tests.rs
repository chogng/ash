use super::*;
use async_utils::CancellationSource;
use client::ClientResponse;
use http_client::HttpHeader;
use std::sync::Mutex;

struct Client {
    response: Result<ClientResponse, ClientError>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl Client {
    fn response(status: u16, body: &str) -> Self {
        Self {
            response: Ok(ClientResponse::new(
                status,
                Vec::new(),
                body.as_bytes().to_vec(),
            )),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.response.clone()
    }
}

fn target(base: &str) -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        base,
        vec![
            HttpHeader::new("Authorization", "Bearer secret"),
            HttpHeader::new("ChatGPT-Account-ID", "account-1"),
            HttpHeader::new("User-Agent", "Ash/test"),
            HttpHeader::new("X-OpenAI-Fedramp", "true"),
        ],
    )
}

#[test]
fn both_routes_preserve_authentication_and_exact_usage_windows() {
    let body = r#"{
        "account_id":"account-1", "plan_type":"future-plan",
        "rate_limit":{"allowed":true,"limit_reached":false,
            "primary_window":{"used_percent":17,"limit_window_seconds":18000,"reset_at":2000000000},
            "secondary_window":{"used_percent":96,"limit_window_seconds":604800,"reset_at":2000500000}},
        "additional_rate_limits":[{"metered_feature":"codex_extra","limit_name":"Extra model",
            "normal_model_slug":"extra-model","rate_limit":{"allowed":false,"limit_reached":true,
            "primary_window":{"used_percent":100,"limit_window_seconds":60,"reset_at":2000000001}}}],
        "credits":{"has_credits":true,"unlimited":false,"balance":"12.50"}
    }"#;
    for (base, route, expected) in [
        (
            "https://example.test/",
            RouteStyle::Codex,
            "https://example.test/api/codex/usage",
        ),
        (
            CHATGPT_BACKEND_BASE_URL,
            RouteStyle::ChatGpt,
            "https://chatgpt.com/backend-api/wham/usage",
        ),
    ] {
        let client = Client::response(200, body);
        let target = target(base);
        let actual = BackendClient::new(&client, &target, route)
            .unwrap()
            .read_rate_limits(&CancellationSource::new().token())
            .unwrap();
        assert_eq!(
            actual,
            RateLimits {
                account_id: Some("account-1".into()),
                plan: "future-plan".into(),
                limits: vec![
                    RateLimit {
                        id: "codex".into(),
                        name: None,
                        model: None,
                        allowed: Some(true),
                        limit_reached: Some(false),
                        primary: Some(RateLimitWindow {
                            used_percent: 17,
                            window_seconds: 18000,
                            resets_at: 2000000000
                        }),
                        secondary: Some(RateLimitWindow {
                            used_percent: 96,
                            window_seconds: 604800,
                            resets_at: 2000500000
                        })
                    },
                    RateLimit {
                        id: "codex_extra".into(),
                        name: Some("Extra model".into()),
                        model: Some("extra-model".into()),
                        allowed: Some(false),
                        limit_reached: Some(true),
                        primary: Some(RateLimitWindow {
                            used_percent: 100,
                            window_seconds: 60,
                            resets_at: 2000000001
                        }),
                        secondary: None
                    }
                ],
                credits: Some(CreditBalance {
                    has_credits: true,
                    unlimited: false,
                    balance: Some("12.50".into())
                }),
            }
        );
        let requests = client.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url(), expected);
        assert_eq!(requests[0].headers(), target.headers);
        assert_eq!(requests[0].method(), HttpMethod::Get);
        assert!(requests[0].body().is_empty());
        assert_eq!(requests[0].retry_policy(), RetryPolicy::never());
    }
}

#[test]
fn absent_and_null_limits_are_unknown_instead_of_zero_usage() {
    for body in [
        r#"{"plan_type":"plus"}"#,
        r#"{"plan_type":"plus","rate_limit":null,"additional_rate_limits":null,"credits":null}"#,
    ] {
        let client = Client::response(200, body);
        let target = target(CHATGPT_BACKEND_BASE_URL);
        let usage = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_rate_limits(&CancellationSource::new().token())
            .unwrap();
        assert_eq!(
            usage,
            RateLimits {
                account_id: None,
                plan: "plus".into(),
                credits: None,
                limits: vec![RateLimit {
                    id: "codex".into(),
                    name: None,
                    model: None,
                    allowed: None,
                    limit_reached: None,
                    primary: None,
                    secondary: None
                }],
            }
        );
    }
}

#[test]
fn status_and_decode_errors_never_include_upstream_content() {
    for (status, body, expected) in [
        (401, "secret credential", RequestError::HttpStatus(401)),
        (429, "private quota detail", RequestError::HttpStatus(429)),
        (
            503,
            "https://private.test/?secret",
            RequestError::HttpStatus(503),
        ),
        (302, "redirect location", RequestError::HttpStatus(302)),
        (200, "<html>secret</html>", RequestError::InvalidResponse),
        (200, r#"{"rate_limit":null}"#, RequestError::InvalidResponse),
        (
            200,
            r#"{"plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":-1,"limit_window_seconds":60,"reset_at":42}}}"#,
            RequestError::InvalidResponse,
        ),
    ] {
        let client = Client::response(status, body);
        let target = target(CHATGPT_BACKEND_BASE_URL);
        let error = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_rate_limits(&CancellationSource::new().token())
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains(body));
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn cancellation_prevents_a_request_and_transport_errors_are_redacted() {
    let client = Client {
        response: Err(ClientError::Transport("Bearer secret".into())),
        requests: Mutex::new(Vec::new()),
    };
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert_eq!(
        backend.read_rate_limits(&cancelled.token()),
        Err(RequestError::Cancelled)
    );
    assert!(client.requests.lock().unwrap().is_empty());
    assert_eq!(
        backend.read_rate_limits(&CancellationSource::new().token()),
        Err(RequestError::Transport)
    );
}

#[test]
fn ambiguous_or_unsecured_base_urls_are_rejected_before_sending_credentials() {
    let client = Client::response(200, "{}");
    for base in [
        "http://example.test",
        "https://user:secret@example.test",
        "https://example.test/?key=secret",
        "https://example.test/#fragment",
        "invalid",
    ] {
        let target = target(base);
        assert!(matches!(
            BackendClient::new(&client, &target, RouteStyle::Codex),
            Err(RequestError::InvalidTarget)
        ));
    }
    assert!(client.requests.lock().unwrap().is_empty());
}
