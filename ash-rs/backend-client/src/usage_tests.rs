use crate::test_support::Client;
use crate::test_support::target;
use crate::*;
use ::client::RetryPolicy;
use async_utils::CancellationSource;
use http_client::HttpHeader;
use http_client::HttpMethod;
use serde_json::json;

#[test]
fn usage_keeps_server_permission_independent_of_displayed_percentage() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    for (allowed, reached, percent) in [
        (Some(true), Some(false), 100),
        (Some(false), Some(true), 0),
        (None, None, 42),
    ] {
        let limit = allowed.map(|allowed| json!({"allowed":allowed,"limit_reached":reached,"primary_window":{"used_percent":percent,"limit_window_seconds":18000,"reset_at":2000000000}}));
        let client = Client::response(
            200,
            &json!({"plan_type":"plus","rate_limit":limit}).to_string(),
        );
        let usage = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_rate_limits(&CancellationSource::new().token())
            .unwrap();
        assert_eq!(usage.limits[0].allowed, allowed);
        assert_eq!(usage.limits[0].limit_reached, reached);
        assert_eq!(
            usage.limits[0]
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            allowed.map(|_| percent)
        );
    }
}

#[test]
fn reset_credits_preserve_server_order_status_and_optional_metadata() {
    let client = Client::response(
        200,
        r#"{"credits":[{"id":"expired","reset_type":"full","status":"expired","granted_at":"2026-09-01","expires_at":"2026-09-10","title":"Gift","description":"Expired gift","future_field":true},{"id":"available","reset_type":"future","status":"available","granted_at":"2026-09-20"}],"available_count":1}"#,
    );
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let credits = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .list_reset_credits(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(credits.available_count, 1);
    assert_eq!(credits.credits.len(), 2);
    assert_eq!(
        credits.credits[0],
        ResetCredit {
            id: "expired".into(),
            reset_type: "full".into(),
            status: "expired".into(),
            granted_at: "2026-09-01".into(),
            expires_at: Some("2026-09-10".into()),
            title: Some("Gift".into()),
            description: Some("Expired gift".into())
        }
    );
    assert_eq!(credits.credits[1].id, "available");
    assert_eq!(credits.credits[1].reset_type, "future");
    assert_eq!(credits.credits[1].expires_at, None);
    assert_eq!(credits.credits[1].title, None);
}

#[test]
fn reset_credit_results_preserve_window_counts_and_reject_unknown_outcomes() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    for (body, expected) in [
        (
            r#"{"code":"reset","windows_reset":2}"#,
            Ok(ResetCreditResult {
                code: ResetCreditCode::Reset,
                windows_reset: 2,
            }),
        ),
        (
            r#"{"code":"no_credit"}"#,
            Ok(ResetCreditResult {
                code: ResetCreditCode::NoCredit,
                windows_reset: 0,
            }),
        ),
        (r#"{"code":"future"}"#, Err(RequestError::InvalidResponse)),
        (
            r#"{"code":"reset","windows_reset":-1}"#,
            Err(RequestError::InvalidResponse),
        ),
        (
            r#"{"code":"reset","windows_reset":null}"#,
            Err(RequestError::InvalidResponse),
        ),
    ] {
        let client = Client::response(200, body);
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .consume_reset_credit(
                    "stable-id",
                    ResetCreditSelection::Available,
                    &CancellationSource::new().token()
                ),
            expected
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
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
        (
            "https://example.test/base///",
            RouteStyle::Codex,
            "https://example.test/base/api/codex/usage",
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
fn usage_metadata_and_reset_credit_selection_preserve_the_backend_contract() {
    let body = json!({
        "plan_type":"enterprise", "user_id":"user-1", "account_id":"account-1",
        "rate_limit_reset_credits":{"available_count":3},
        "rate_limit":{"allowed":false,"limit_reached":true},
        "rate_limit_reached_type":{"type":"workspace_owner_credits"},
        "spend_control":{"reached":true,"individual_limit":{"source":"user","limit":"100.00","used":"100.00","remaining":"0","used_percent":100,"remaining_percent":0,"reset_after_seconds":20,"reset_at":2100000000}},
        "rate_limit_upsell":{"type":"workspace_credits","message":"Contact owner"}
    });
    let client = Client::response(200, &body.to_string());
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let status = backend.read_rate_limit_status(&token).unwrap();
    assert_eq!(status.user_id.as_deref(), Some("user-1"));
    assert_eq!(status.reset_credits.unwrap().available_count, 3);
    assert_eq!(status.usage.limits[0].allowed, Some(false));
    assert_eq!(status.reached_type.unwrap().kind, "workspace_owner_credits");
    assert_eq!(
        status
            .spend_control
            .unwrap()
            .individual_limit
            .unwrap()
            .limit,
        "100.00"
    );
    assert_eq!(status.upsell.unwrap()["message"], "Contact owner");
    backend.read_rate_limits_with_reserve(&token).unwrap();
    let requests = client.requests.lock().unwrap();
    assert!(!requests[0].headers().iter().any(|header| {
        header
            .name()
            .eq_ignore_ascii_case("x-openai-codex-luna-reserve")
    }));
    assert!(
        requests[1]
            .headers()
            .contains(&HttpHeader::new("x-openai-codex-luna-reserve", "1"))
    );
    drop(requests);

    for (wire, expected) in [
        ("reset", ResetCreditCode::Reset),
        ("already_redeemed", ResetCreditCode::AlreadyRedeemed),
        ("nothing_to_reset", ResetCreditCode::NothingToReset),
        ("no_credit", ResetCreditCode::NoCredit),
    ] {
        let client = Client::response(200, &json!({"code":wire}).to_string());
        let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
        for selection in [
            ResetCreditSelection::Available,
            ResetCreditSelection::Id("credit-1"),
        ] {
            assert_eq!(
                backend
                    .consume_reset_credit("stable-request", selection, &token)
                    .unwrap()
                    .code,
                expected
            );
        }
        let requests = client.requests.lock().unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
            json!({"redeem_request_id":"stable-request"})
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(requests[1].body()).unwrap(),
            json!({"redeem_request_id":"stable-request","credit_id":"credit-1"})
        );
    }
    let client = Client::response(
        200,
        r#"{"credits":[{"id":"c","reset_type":"full","status":"available","granted_at":"2026-09-01","expires_at":null,"title":"Gift"}],"available_count":1}"#,
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::Codex).unwrap();
    let credits = backend.list_reset_credits(&token).unwrap();
    assert_eq!(credits.credits[0].title.as_deref(), Some("Gift"));
    assert_eq!(credits.credits[0].expires_at, None);
    for (id, selection) in [
        (" ", ResetCreditSelection::Available),
        ("valid", ResetCreditSelection::Id("")),
    ] {
        assert_eq!(
            backend.consume_reset_credit(id, selection, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}
