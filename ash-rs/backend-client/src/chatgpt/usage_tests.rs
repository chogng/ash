use crate::chatgpt::test_support::target;
use crate::chatgpt::*;
use crate::test_support::Transport;
use ::client::RetryPolicy;
use async_utils::CancellationSource;
use http_client::HttpHeader;
use http_client::HttpMethod;
use serde_json::json;

#[test]
fn usage_keeps_server_permission_independent_of_displayed_percentage() {
    let target = target(BASE_URL);
    for (allowed, reached, percent) in [
        (Some(true), Some(false), 100),
        (Some(false), Some(true), 0),
        (None, None, 42),
    ] {
        let limit = allowed.map(|allowed| json!({"allowed":allowed,"limit_reached":reached,"primary_window":{"used_percent":percent,"limit_window_seconds":18000,"reset_at":2000000000}}));
        let client = Transport::response(
            200,
            &json!({"plan_type":"plus","rate_limit":limit}).to_string(),
        );
        let usage = Client::new(&client, &target, RouteStyle::ChatGpt)
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
            BASE_URL,
            RouteStyle::ChatGpt,
            "https://chatgpt.com/backend-api/wham/usage",
        ),
        (
            "https://example.test/base///",
            RouteStyle::Codex,
            "https://example.test/base/api/codex/usage",
        ),
    ] {
        let client = Transport::response(200, body);
        let target = target(base);
        let actual = Client::new(&client, &target, route)
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
        let client = Transport::response(200, body);
        let target = target(BASE_URL);
        let usage = Client::new(&client, &target, RouteStyle::ChatGpt)
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
fn usage_metadata_and_reserve_header_preserve_the_backend_contract() {
    let body = json!({
        "plan_type":"enterprise", "user_id":"user-1", "account_id":"account-1",
        "rate_limit":{"allowed":false,"limit_reached":true},
        "rate_limit_reached_type":{"type":"workspace_owner_credits"},
        "spend_control":{"reached":true,"individual_limit":{"source":"user","limit":"100.00","used":"100.00","remaining":"0","used_percent":100,"remaining_percent":0,"reset_after_seconds":20,"reset_at":2100000000}},
    });
    let client = Transport::response(200, &body.to_string());
    let target = target(BASE_URL);
    let token = CancellationSource::new().token();
    let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let status = backend.read_rate_limit_status(&token).unwrap();
    assert_eq!(status.user_id.as_deref(), Some("user-1"));
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
}
