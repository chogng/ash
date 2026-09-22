use crate::RequestError;
use crate::chatgpt::test_support::target;
use crate::chatgpt::*;
use crate::test_support::Transport;
use ::client::ClientError;
use ::client::ClientRequest;
use ::client::ClientResponse;
use ::client::OperationClient;
use ::client::RetryPolicy;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use http_client::HttpMethod;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

type Operation = fn(&Client<'_>, &CancellationToken) -> Result<(), RequestError>;

fn turn_query() -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([("thread-1".into(), vec!["turn-1".into()])])
}

fn task_query() -> Vec<TaskUsageThread> {
    vec![TaskUsageThread {
        thread_id: "thread-1".into(),
        created_at: Some("2026-09-01T00:00:00Z".into()),
        descendant_thread_ids: vec!["child-1".into()],
    }]
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
        let client = Transport::response(status, body);
        let target = target(BASE_URL);
        let error = Client::new(&client, &target, RouteStyle::ChatGpt)
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
    let client = Transport {
        response: Err(ClientError::Transport("Bearer secret".into())),
        requests: Mutex::new(Vec::new()),
    };
    let target = target(BASE_URL);
    let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
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
    let client = Transport::response(200, "{}");
    for base in [
        "http://example.test",
        "https://user:secret@example.test",
        "https://example.test/?key=secret",
        "https://example.test/#fragment",
        "invalid",
    ] {
        let target = target(base);
        assert!(matches!(
            Client::new(&client, &target, RouteStyle::Codex),
            Err(RequestError::InvalidTarget)
        ));
    }
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn business_endpoints_use_both_routes_auth_cancellation_and_redacted_failures() {
    let operations: &[(&str, HttpMethod, &str, Operation)] = &[
        (
            "accounts/check",
            HttpMethod::Get,
            r#"{"accounts":[]}"#,
            |backend, token| backend.read_accounts(token).map(|_| ()),
        ),
        (
            "profiles/me",
            HttpMethod::Get,
            r#"{"stats":{}}"#,
            |backend, token| backend.read_account_profile(token).map(|_| ()),
        ),
        ("config/bundle", HttpMethod::Get, "{}", |backend, token| {
            backend.read_config_bundle(token).map(|_| ())
        }),
        ("settings/user", HttpMethod::Get, "{}", |backend, token| {
            backend.read_user_settings(token).map(|_| ())
        }),
        (
            "workspace-messages",
            HttpMethod::Get,
            r#"{"messages":[]}"#,
            |backend, token| backend.list_workspace_messages(token).map(|_| ()),
        ),
        (
            "rate-limit-reset-credits",
            HttpMethod::Get,
            r#"{"credits":[],"available_count":0}"#,
            |backend, token| backend.list_reset_credits(token).map(|_| ()),
        ),
        (
            "rate-limit-reset-credits/consume",
            HttpMethod::Post,
            r#"{"code":"reset","windows_reset":2}"#,
            |backend, token| {
                backend
                    .consume_reset_credit("request-1", ResetCreditSelection::Available, token)
                    .map(|_| ())
            },
        ),
        (
            "usage",
            HttpMethod::Get,
            r#"{"plan_type":"plus"}"#,
            |backend, token| backend.read_rate_limit_status(token).map(|_| ()),
        ),
        (
            "usage",
            HttpMethod::Get,
            r#"{"plan_type":"plus"}"#,
            |backend, token| backend.read_rate_limits_with_reserve(token).map(|_| ()),
        ),
        (
            "tasks/list",
            HttpMethod::Get,
            r#"{"items":[]}"#,
            |backend, token| {
                backend
                    .list_tasks(&TaskListQuery::default(), token)
                    .map(|_| ())
            },
        ),
        (
            "tasks/task-1",
            HttpMethod::Get,
            r#"{"task":{"id":"task-1","title":"Task","archived":false,"external_pull_requests":[]}}"#,
            |backend, token| backend.read_task("task-1", token).map(|_| ()),
        ),
        (
            "tasks/task-1/turns/turn-1/sibling_turns",
            HttpMethod::Get,
            r#"{"sibling_turns":[]}"#,
            |backend, token| {
                backend
                    .list_sibling_turns("task-1", "turn-1", token)
                    .map(|_| ())
            },
        ),
        (
            "tasks",
            HttpMethod::Post,
            r#"{"task":{"id":"task-1"}}"#,
            |backend, token| {
                backend
                    .create_task(json!({"input_items":[]}).as_object().unwrap(), token)
                    .map(|_| ())
            },
        ),
        (
            "usage/thread_usage/query",
            HttpMethod::Post,
            r#"{"threads":[]}"#,
            |backend, token| backend.read_thread_usage(&["thread-1"], token).map(|_| ()),
        ),
        (
            "usage/thread_usage/query_v2",
            HttpMethod::Post,
            r#"{"threads":[]}"#,
            |backend, token| backend.read_task_usage(&task_query(), token).map(|_| ()),
        ),
        (
            "usage/thread-estimates/query",
            HttpMethod::Post,
            r#"{"threads":[]}"#,
            |backend, token| {
                backend
                    .query_chatgpt_turn_costs(&turn_query(), token)
                    .map(|_| ())
            },
        ),
        (
            "usage/plan_limit_history",
            HttpMethod::Get,
            r#"{"coverage_complete":false,"periods":[]}"#,
            |backend, token| backend.read_plan_limit_history(token).map(|_| ()),
        ),
    ];
    for (route, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        let target = target("https://example.test/backend-api/");
        for (path, method, body, run) in operations {
            let client = Transport::response(200, body);
            let backend = Client::new(&client, &target, route).unwrap();
            let token = CancellationSource::new().token();
            run(&backend, &token).unwrap_or_else(|error| panic!("{path}: {error}"));
            {
                let requests = client.requests.lock().unwrap();
                assert_eq!(requests.len(), 1, "{path}");
                let request = &requests[0];
                let url = url::Url::parse(request.url()).unwrap();
                assert_eq!(url.path(), format!("/backend-api/{prefix}/{path}"));
                assert_eq!(request.method(), *method);
                assert_eq!(request.retry_policy(), RetryPolicy::never());
                for header in &target.headers {
                    assert!(request.headers().contains(header), "{path}");
                }
                if *method == HttpMethod::Post {
                    assert!(
                        request
                            .headers()
                            .contains(&HttpHeader::new("Content-Type", "application/json"))
                    );
                    assert!(
                        serde_json::from_slice::<serde_json::Value>(request.body())
                            .unwrap()
                            .is_object()
                    );
                } else {
                    assert!(request.body().is_empty());
                }
            }
            let cancelled = CancellationSource::new();
            cancelled.cancel();
            assert_eq!(
                run(&backend, &cancelled.token()),
                Err(RequestError::Cancelled),
                "{path}"
            );
            assert_eq!(client.requests.lock().unwrap().len(), 1);
            for status in [302, 401, 429, 503] {
                let client = Transport::response(status, "private account response");
                let backend = Client::new(&client, &target, route).unwrap();
                let error = run(&backend, &token).unwrap_err();
                assert_eq!(error, RequestError::HttpStatus(status), "{path}");
                assert!(!format!("{error:?} {error}").contains("private"));
                assert_eq!(client.requests.lock().unwrap().len(), 1);
            }
            {
                let client = Transport::response(200, "<html>private</html>");
                let backend = Client::new(&client, &target, route).unwrap();
                assert_eq!(
                    run(&backend, &token),
                    Err(RequestError::InvalidResponse),
                    "{path}"
                );
            }
        }
    }
}

#[test]
fn cancellation_after_dispatch_does_not_turn_a_write_into_a_retry() {
    struct CancellingClient {
        source: CancellationSource,
        requests: Mutex<Vec<ClientRequest>>,
    }
    impl OperationClient for CancellingClient {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            self.source.cancel();
            Ok(ClientResponse::new(
                200,
                Vec::new(),
                br#"{"task":{"id":"task-1"}}"#.to_vec(),
            ))
        }
    }
    let client = CancellingClient {
        source: CancellationSource::new(),
        requests: Mutex::new(Vec::new()),
    };
    let target = target(BASE_URL);
    let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    assert_eq!(
        backend.create_task(
            json!({"input_items":[]}).as_object().unwrap(),
            &client.source.token()
        ),
        Err(RequestError::Cancelled)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}
