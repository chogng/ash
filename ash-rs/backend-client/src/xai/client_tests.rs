use super::*;
use crate::test_support::Transport;
use ::client::RetryPolicy;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use http_client::HttpMethod;

type Operation = fn(&Client<'_>, &CancellationToken) -> Result<(), RequestError>;

#[test]
fn subscription_routes_preserve_auth_cancel_status_and_never_retry() {
    let operations: &[(&str, &str, Operation)] = &[
        ("models-v2", r#"{"data":[]}"#, |c, t| {
            c.read_models(t).map(|_| ())
        }),
        (
            "user?include=subscription",
            r#"{"userId":"user-1"}"#,
            |c, t| c.read_account(t).map(|_| ()),
        ),
        ("settings", "{}", |c, t| c.read_settings(t).map(|_| ())),
        ("billing?format=credits", r#"{"config":null}"#, |c, t| {
            c.read_billing(t).map(|_| ())
        }),
    ];
    for (path, body, run) in operations {
        for status in [200, 401, 403, 426, 429, 503] {
            let transport = Transport::response(status, body);
            let target = ResolvedApiTarget::new(
                BASE_URL,
                vec![
                    HttpHeader::new("Authorization", "Bearer fixture"),
                    HttpHeader::new("x-grok-client-version", "1.0.38"),
                ],
            );
            let client = Client::new(&transport, &target).unwrap();
            let cancel = CancellationSource::new();
            let result = run(&client, &cancel.token());
            assert_eq!(
                result,
                if status == 200 {
                    Ok(())
                } else {
                    Err(RequestError::HttpStatus(status))
                }
            );
            let requests = transport.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].url(), format!("{BASE_URL}/{path}"));
            assert_eq!(requests[0].method(), HttpMethod::Get);
            assert_eq!(requests[0].retry_policy(), RetryPolicy::never());
            for header in &target.headers {
                assert!(requests[0].headers().contains(header));
            }
            drop(requests);
            cancel.cancel();
            assert_eq!(run(&client, &cancel.token()), Err(RequestError::Cancelled));
            assert_eq!(transport.requests.lock().unwrap().len(), 1);
        }
    }
}

#[test]
fn credits_keep_fractional_percent_exact_cents_and_missing_fields() {
    let transport = Transport::response(
        200,
        r#"{"config":{"creditUsagePercent":105.125,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-09-28T00:00:00Z"},"prepaidBalance":{"val":"9007199254740993"},"onDemandUsed":{},"isUnifiedBillingUser":false,"history":[{"billingCycle":{"year":2026,"month":8},"totalUsed":{"val":123}}]}}"#,
    );
    let target = ResolvedApiTarget::new(BASE_URL, vec![]);
    let data = Client::new(&transport, &target)
        .unwrap()
        .read_billing(&CancellationSource::new().token())
        .unwrap()
        .unwrap();
    assert_eq!(data.credit_usage_percent, Some(105.125));
    assert_eq!(data.prepaid_balance.unwrap().val, 9_007_199_254_740_993);
    assert_eq!(data.on_demand_used.unwrap().val, 0);
    assert_eq!(data.on_demand_cap, None);
    assert_eq!(data.current_period.unwrap().start, None);
    assert_eq!(data.is_unified_billing_user, Some(false));
    assert_eq!(data.history[0].total_used.as_ref().unwrap().val, 123);
    assert_eq!(data.history[0].included_used, None);
    for body in [
        "[]",
        r#"{"config":{"creditUsagePercent":-1}}"#,
        r#"{"config":{"prepaidBalance":{"val":1.5}}}"#,
        r#"{"config":{"prepaidBalance":{"val":"9223372036854775808"}}}"#,
    ] {
        let transport = Transport::response(200, body);
        assert_eq!(
            Client::new(&transport, &target)
                .unwrap()
                .read_billing(&CancellationSource::new().token()),
            Err(RequestError::InvalidResponse)
        );
    }
}

#[test]
fn account_settings_follow_the_upstream_shapes() {
    let target = ResolvedApiTarget::new(BASE_URL, vec![]);
    let token = CancellationSource::new().token();
    let transport = Transport::response(
        200,
        r#"{"userId":"user-1","firstName":"Ada","teamId":"team-1","subscriptionTier":"SuperGrokPro","codingDataRetentionOptOut":true}"#,
    );
    let account = Client::new(&transport, &target)
        .unwrap()
        .read_account(&token)
        .unwrap();
    assert_eq!(account.subscription_tier.as_deref(), Some("SuperGrokPro"));
    assert_eq!(account.email, None);
    assert_eq!(account.coding_data_retention_opt_out, Some(true));
    let transport = Transport::response(
        200,
        r#"{"subscription_tier_display":"SuperGrok","allow_access":false,"on_demand_enabled":false,"leader_mode":true}"#,
    );
    let settings = Client::new(&transport, &target)
        .unwrap()
        .read_settings(&token)
        .unwrap();
    assert_eq!(settings.allow_access, Some(false));
    assert_eq!(settings.on_demand_enabled, Some(false));
    let transport = Transport::response(200, r#"{"userId":" "}"#);
    assert_eq!(
        Client::new(&transport, &target)
            .unwrap()
            .read_account(&token),
        Err(RequestError::InvalidResponse)
    );
}
