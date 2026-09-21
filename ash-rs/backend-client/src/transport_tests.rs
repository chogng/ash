//! Public backend operations through AshClient, UreqHttpClient, and a loopback TLS server.

use crate::BackendClient;
use crate::CreditNudge;
use crate::RequestError;
use crate::ResetCreditSelection;
use crate::RouteStyle;
use crate::TaskListQuery;
use crate::test_support::target;
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
fn both_routes_send_authentication_queries_and_json_over_https() {
    for (route, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        let mut replies = [
            response(200, r#"{"plan_type":"plus"}"#),
            response(200, r#"{"items":[],"cursor":"next"}"#),
            response(201, r#"{"task":{"id":"new-task"}}"#),
            response(204, ""),
        ]
        .into_iter();
        let server = Server::start(move |stream| {
            stream
                .write_all(&replies.next().expect("unexpected extra request"))
                .unwrap()
        });
        let transport = client();
        let target = target(&format!("{}/backend-api/", server.url()));
        let backend = BackendClient::new(&transport, &target, route).unwrap();
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
        backend
            .send_credit_nudge(CreditNudge::Credits, &token)
            .unwrap();
        for (index, request) in (0..4).map(|i| (i, server.request())) {
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
                3 => {
                    assert_eq!(
                        request.line,
                        format!(
                            "POST /backend-api/{prefix}/accounts/send_add_credits_nudge_email HTTP/1.1"
                        )
                    );
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                        json!({"credit_type":"credits"})
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
fn failed_credit_redemptions_are_never_replayed_by_the_transport() {
    for status in [429, 503] {
        let server = Server::reply(response(status, "private-account-response"));
        let transport = client();
        let target = target(&format!("{}/backend-api/", server.url()));
        let error = BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Id("credit-1"),
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, RequestError::HttpStatus(status));
        assert!(!format!("{error:?} {error}").contains("private-account"));
        let request = server.request();
        assert_eq!(
            request.line,
            "POST /backend-api/wham/rate-limit-reset-credits/consume HTTP/1.1"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            json!({"redeem_request_id":"stable-id","credit_id":"credit-1"})
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
        let error = BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Available,
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains("private-account"));
        server.request();
        server.assert_no_more_requests();
    }
}
