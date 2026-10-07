use crate::chatgpt::RedeemRequest;
use crate::chatgpt::TaskUsageResponse;
use crate::chatgpt::UsageResponse;
use crate::coding_plan::BusinessResponse;
use crate::coding_plan::Quota;
use crate::coding_plan::ResponseCode;
use crate::kimi::Usage;
use crate::supergrok::BillingResponse;
use crate::supergrok::ModelsResponse;
use crate::zai::LoginRequest;
use crate::zai::LoginResponse;
use serde_json::json;

#[test]
fn chatgpt_usage_retains_open_dimensions_and_provider_window_units() {
    let usage: UsageResponse =
        serde_json::from_str(include_str!("../tests/fixtures/chatgpt_usage.json")).unwrap();
    assert_eq!(usage.plan_type, "future-plan");
    let limit = usage.rate_limit.unwrap();
    assert!(!limit.allowed);
    assert!(limit.limit_reached);
    let window = limit.primary_window.unwrap();
    assert_eq!(window.used_percent, 103);
    assert_eq!(window.limit_window_seconds, 18_000);
    assert_eq!(window.reset_at, 1_790_553_600);
    assert!(limit.secondary_window.is_none());
    assert_eq!(
        usage.credits.unwrap().balance.as_deref(),
        Some("123456789.000001")
    );
    let additional = usage.additional_rate_limits.unwrap();
    assert_eq!(additional[0].metered_feature, "future-feature");
    assert!(additional[0].rate_limit.is_none());
    assert!(usage.account_id.is_none());
    assert!(usage.spend_control.is_none());
}

#[test]
fn kimi_usage_retains_fractional_ratios_and_calendar_offsets() {
    let usage: Usage =
        serde_json::from_str(include_str!("../tests/fixtures/kimi_usage.json")).unwrap();
    let window = usage.usages.limit_5h.unwrap();
    assert_eq!(window.used_ratio, 1.035);
    let reset = window.reset_time.unwrap();
    assert_eq!(reset.offset().local_minus_utc(), 8 * 3_600);
    assert!(usage.usages.limit_7d.is_none());
    assert!(usage.usages.limit_month_total.unwrap().reset_time.is_none());
    assert_eq!(usage.usages.limit_month_code.unwrap().used_ratio, 0.05);
}

#[test]
fn grok_billing_preserves_exact_cents_and_explicit_proto_zero() {
    let response: BillingResponse =
        serde_json::from_str(include_str!("../tests/fixtures/supergrok_billing.json")).unwrap();
    let billing = response.config.unwrap();
    assert_eq!(billing.credit_usage_percent, Some(103.5));
    assert_eq!(billing.prepaid_balance.unwrap().val, 9_007_199_254_740_993);
    assert_eq!(billing.on_demand_used.unwrap().val, 0);
    assert!(billing.on_demand_cap.is_none());
    assert_eq!(
        billing.current_period.unwrap().period_type.as_deref(),
        Some("weekly")
    );
}

#[test]
fn coding_plan_quota_preserves_business_code_and_millisecond_timestamps() {
    let response: BusinessResponse<Quota> =
        serde_json::from_str(include_str!("../tests/fixtures/coding_plan_quota.json")).unwrap();
    assert!(matches!(response.code, Some(ResponseCode::Text(code)) if code == "200"));
    assert_eq!(
        response.data.limits[0].next_reset_time,
        Some(1_790_553_600_000)
    );
    assert_eq!(response.data.limits[0].percentage, Some(12.5));
    assert!(response.data.limits[1].percentage.is_none());
    assert!(response.data.limits[1].next_reset_time.is_none());
    for malformed in [
        json!({"code":200}),
        json!({"code":200,"data":null}),
        json!({"code":200,"data":{"limits":null}}),
    ] {
        assert!(serde_json::from_value::<BusinessResponse<Quota>>(malformed).is_err());
    }
}

#[test]
fn requests_keep_provider_field_names_and_omit_unselected_credit_id() {
    assert_eq!(
        serde_json::to_value(RedeemRequest {
            redeem_request_id: "operation-1",
            credit_id: None,
        })
        .unwrap(),
        json!({"redeem_request_id":"operation-1"})
    );
    assert_eq!(
        serde_json::to_value(RedeemRequest {
            redeem_request_id: "operation-1",
            credit_id: Some("credit-1"),
        })
        .unwrap(),
        json!({"redeem_request_id":"operation-1","credit_id":"credit-1"})
    );
    assert_eq!(
        serde_json::to_value(LoginRequest {
            token: "account-token"
        })
        .unwrap(),
        json!({"token":"account-token"})
    );
    for field in ["access_token", "accessToken"] {
        let token: LoginResponse = serde_json::from_value(json!({field:"business-token"})).unwrap();
        assert_eq!(token.access_token, "business-token");
    }
}

#[test]
fn task_debits_preserve_decimal_text_and_fractional_percentages() {
    let response: TaskUsageResponse = serde_json::from_value(json!({
        "threads":[{
            "thread_id":"task-1", "data_status":"available", "usage_source":"backend",
            "five_hour_limit_percent":0.125, "weekly_limit_percent":103.5,
            "balance_usage_credits":"-123456789.000001e-3", "groups":[]
        }]
    }))
    .unwrap();
    assert_eq!(
        response.threads[0].amounts.five_hour_limit_percent,
        Some(0.125)
    );
    assert_eq!(
        response.threads[0].amounts.weekly_limit_percent,
        Some(103.5)
    );
    assert_eq!(
        response.threads[0].amounts.balance_usage_credits.as_deref(),
        Some("-123456789.000001e-3")
    );
}

#[test]
fn grok_models_preserve_extensible_metadata_without_interpreting_it() {
    let response: ModelsResponse = serde_json::from_value(json!({
        "data":[{"model":"future","_meta":{"reasoningEfforts":[{"value":"future-effort"}]}}]
    }))
    .unwrap();
    assert_eq!(
        response.data[0]["_meta"]["reasoningEfforts"][0]["value"],
        "future-effort"
    );
    assert!(serde_json::from_value::<ModelsResponse>(json!({"models":[]})).is_err());
    assert!(serde_json::from_value::<ModelsResponse>(json!({"data":[null]})).is_err());
}
