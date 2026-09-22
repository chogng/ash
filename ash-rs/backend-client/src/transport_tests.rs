//! Public backend operations through AshClient, UreqHttpClient, and a loopback TLS server.

use crate::RequestError;
use crate::chatgpt::Client;
use crate::chatgpt::ResetCreditCode;
use crate::chatgpt::ResetCreditSelection;
use crate::chatgpt::RouteStyle;
use crate::chatgpt::TaskListQuery;
use crate::chatgpt::test_support::target;
use ::client::AshClient;
use async_utils::CancellationSource;
use http_client::CertificateBundle;
use http_client::HttpClientConfig;
use http_client::ProxyPolicy;
use http_client::Timeout;
use http_client::TlsPolicy;
use http_client::TransportTimeouts;
use http_client::UreqHttpClient;
use http_test_support::CA_DER;
use http_test_support::Server;
use http_test_support::response;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn existing_reset_credits_can_be_queried_and_used_without_replaying_failures() {
    for (route, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        for status in [200, 429, 503] {
            let mut replies = [
                response(200, r#"{"credits":[{"id":"credit-1","reset_type":"full","status":"available","granted_at":"2026-09-01"}],"available_count":1}"#),
                response(status, if status == 200 { r#"{"code":"reset","windows_reset":2}"# } else { "private-account-response" }),
            ].into_iter();
            let server = Server::start(move |stream| {
                stream
                    .write_all(&replies.next().expect("extra request"))
                    .unwrap()
            });
            let transport = client();
            let target = target(&format!("{}/backend-api/", server.url()));
            let backend = Client::new(&transport, &target, route).unwrap();
            let token = CancellationSource::new().token();
            let credits = backend.list_reset_credits(&token).unwrap();
            assert_eq!(credits.available_count, 1);
            assert_eq!(credits.credits[0].id, "credit-1");
            let result = backend.consume_reset_credit(
                "stable-request",
                ResetCreditSelection::Id(&credits.credits[0].id),
                &token,
            );
            if status == 200 {
                let result = result.unwrap();
                assert_eq!(result.code, ResetCreditCode::Reset);
                assert_eq!(result.windows_reset, 2);
            } else {
                assert_eq!(result, Err(RequestError::HttpStatus(status)));
            }
            let query = server.request();
            assert_eq!(
                query.line,
                format!("GET /backend-api/{prefix}/rate-limit-reset-credits HTTP/1.1")
            );
            assert!(query.body.is_empty());
            let use_credit = server.request();
            assert_eq!(
                use_credit.line,
                format!("POST /backend-api/{prefix}/rate-limit-reset-credits/consume HTTP/1.1")
            );
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&use_credit.body).unwrap(),
                json!({"redeem_request_id":"stable-request","credit_id":"credit-1"})
            );
            for request in [&query, &use_credit] {
                for header in &target.headers {
                    assert_eq!(request.header(header.name()), header.value());
                }
            }
            server.assert_no_more_requests();
        }
    }
}

#[test]
fn xai_business_queries_use_the_credits_contract_over_https() {
    let mut replies = [
        response(200, r#"{"userId":"user-1","subscriptionTier":"SuperGrokPro"}"#),
        response(200, r#"{"allow_access":true}"#),
        response(200, r#"{"config":{"creditUsagePercent":12.125,"prepaidBalance":{"val":"9007199254740993"}}}"#),
    ].into_iter();
    let server = Server::start(move |stream| {
        stream
            .write_all(&replies.next().expect("extra request"))
            .unwrap()
    });
    let transport = client();
    let target = ::client::ResolvedApiTarget::new(
        format!("{}/v1/", server.url()),
        vec![
            http_client::HttpHeader::new("Authorization", "Bearer xai-fixture"),
            http_client::HttpHeader::new("x-userid", "user-1"),
        ],
    );
    let client = crate::xai::Client::new(&transport, &target).unwrap();
    let token = CancellationSource::new().token();
    assert_eq!(client.read_account(&token).unwrap().user_id, "user-1");
    assert_eq!(
        client.read_settings(&token).unwrap().allow_access,
        Some(true)
    );
    let billing = client.read_billing(&token).unwrap().unwrap();
    assert_eq!(billing.credit_usage_percent, Some(12.125));
    assert_eq!(billing.prepaid_balance.unwrap().val, 9_007_199_254_740_993);
    for path in [
        "user?include=subscription",
        "settings",
        "billing?format=credits",
    ] {
        let request = server.request();
        assert_eq!(request.line, format!("GET /v1/{path} HTTP/1.1"));
        assert_eq!(request.header("Authorization"), "Bearer xai-fixture");
        assert_eq!(request.header("x-userid"), "user-1");
        assert_eq!(request.header("Accept"), "application/json");
        assert_eq!(request.header("Cache-Control"), "no-store");
        assert!(request.body.is_empty());
    }
    server.assert_no_more_requests();
}

fn client() -> AshClient {
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(ca))
        .with_timeouts(TransportTimeouts::new(
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(WAIT),
        ));
    AshClient::new(Arc::new(UreqHttpClient::with_config(config).unwrap()))
}

#[test]
fn xai_catalog_uses_its_own_route_and_authentication_over_https() {
    let server = Server::reply(response(
        200,
        r#"{"data":[{"model":"grok-test","apiBackend":"responses","contextWindow":500000,"baseUrl":"https://untrusted.example"}]}"#,
    ));
    let transport = client();
    let target = ::client::ResolvedApiTarget::new(
        format!("{}/v1/", server.url()),
        vec![
            http_client::HttpHeader::new("Authorization", "Bearer xai-secret"),
            http_client::HttpHeader::new("X-XAI-Token-Auth", "xai-grok-cli"),
        ],
    );
    let models = crate::xai::Client::new(&transport, &target)
        .unwrap()
        .read_models(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(models[0].id, "grok-test");
    assert_eq!(models[0].context_window, Some(500000));
    let request = server.request();
    assert_eq!(request.line, "GET /v1/models-v2 HTTP/1.1");
    assert_eq!(request.header("Authorization"), "Bearer xai-secret");
    assert_eq!(request.header("X-XAI-Token-Auth"), "xai-grok-cli");
    assert_eq!(request.header("Accept"), "application/json");
    assert!(request.body.is_empty());
    server.assert_no_more_requests();
}

#[test]
fn both_routes_send_authentication_queries_and_json_over_https() {
    for (route, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        let mut replies = [
            response(200, r#"{"plan_type":"plus"}"#),
            response(200, r#"{"items":[],"cursor":"next"}"#),
            response(201, r#"{"task":{"id":"new-task"}}"#),
        ]
        .into_iter();
        let server = Server::start(move |stream| {
            stream
                .write_all(&replies.next().expect("unexpected extra request"))
                .unwrap()
        });
        let transport = client();
        let target = target(&format!("{}/backend-api/", server.url()));
        let backend = Client::new(&transport, &target, route).unwrap();
        let token = CancellationSource::new().token();
        assert_eq!(backend.read_rate_limits(&token).unwrap().plan, "plus");
        let list = backend
            .list_tasks(
                &TaskListQuery {
                    limit: Some(10),
                    cursor: Some("next=page"),
                    environment_id: Some("env&one"),
                    task_filter: Some("mine / shared"),
                },
                &token,
            )
            .unwrap();
        assert_eq!(list.cursor.as_deref(), Some("next"));
        let payload = json!({"environment_id":"env","input_items":[{"type":"message","content":["检查 Rust"]}]});
        assert_eq!(
            backend
                .create_task(payload.as_object().unwrap(), &token)
                .unwrap(),
            "new-task"
        );
        for (index, request) in (0..3).map(|i| (i, server.request())) {
            for header in &target.headers {
                assert_eq!(request.header(header.name()), header.value());
            }
            match index {
                0 => {
                    assert_eq!(
                        request.line,
                        format!("GET /backend-api/{prefix}/usage HTTP/1.1")
                    );
                    assert!(request.body.is_empty());
                }
                1 => {
                    assert_eq!(
                        request.line,
                        format!(
                            "GET /backend-api/{prefix}/tasks/list?limit=10&task_filter=mine+%2F+shared&cursor=next%3Dpage&environment_id=env%26one HTTP/1.1"
                        )
                    );
                    assert!(request.body.is_empty());
                }
                2 => {
                    assert_eq!(
                        request.line,
                        format!("POST /backend-api/{prefix}/tasks HTTP/1.1")
                    );
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                        payload
                    );
                }
                _ => unreachable!(),
            }
            if index >= 2 {
                assert_eq!(request.header("Content-Type"), "application/json");
            }
        }
        server.assert_no_more_requests();
    }
}

#[test]
fn failed_task_creations_are_never_replayed_by_the_transport() {
    for status in [429, 503] {
        let server = Server::reply(response(status, "private-account-response"));
        let transport = client();
        let target = target(&format!("{}/backend-api/", server.url()));
        let error = Client::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .create_task(
                json!({"input_items":[]}).as_object().unwrap(),
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, RequestError::HttpStatus(status));
        assert!(!format!("{error:?} {error}").contains("private-account"));
        let request = server.request();
        assert_eq!(request.line, "POST /backend-api/wham/tasks HTTP/1.1");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            json!({"input_items":[]})
        );
        server.assert_no_more_requests();
    }
}

#[test]
fn malformed_and_truncated_success_bodies_are_redacted_without_replay() {
    for (wire, expected) in [
        (
            response(200, "<html>private-account</html>"),
            RequestError::InvalidResponse,
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nprivate-account"
                .to_vec(),
            RequestError::Transport,
        ),
    ] {
        let server = Server::reply(wire);
        let transport = client();
        let target = target(&format!("{}/backend-api/", server.url()));
        let error = Client::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .create_task(
                json!({"input_items":[]}).as_object().unwrap(),
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains("private-account"));
        server.request();
        server.assert_no_more_requests();
    }
}
