use super::*;
use crate::test_support::Transport;
use async_utils::CancellationSource;
use client::RetryPolicy;
use http_client::HttpMethod;

fn target() -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        "https://api.kimi.com/coding/v1",
        vec![HttpHeader::new("Authorization", "Bearer fixture")],
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    )
}

#[test]
fn account_and_usage_use_the_coding_origin_and_preserve_quota_windows() {
    let account_transport = Transport::response(
        200,
        r#"{"user_id":"user-1","nickname":"Ada","email":"ada@example.test","user_level_name":"Allegro"}"#,
    );
    let target = target();
    let account = Client::new(&account_transport, &target)
        .unwrap()
        .read_account(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(account.user_level_name.as_deref(), Some("Allegro"));
    let request = &account_transport.requests.lock().unwrap()[0];
    assert_eq!(request.url(), "https://api.kimi.com/coding/v1/me");
    assert_eq!(request.method(), HttpMethod::Get);
    assert_eq!(request.retry_policy(), RetryPolicy::never());
    assert!(
        request
            .headers()
            .contains(&HttpHeader::new("Authorization", "Bearer fixture"))
    );

    let usage_transport = Transport::response(
        200,
        r#"{"usages":{"limit_5h":{"used_ratio":0.125,"reset_time":"2026-09-28T00:00:00Z"},"limit_month_total":{"used_ratio":0.0056,"reset_time":"2026-10-27T00:00:00Z"}}}"#,
    );
    let usage = Client::new(&usage_transport, &target)
        .unwrap()
        .read_usage(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(usage.usages.limit_5h.unwrap().used_ratio, 0.125);
    assert_eq!(usage.usages.limit_7d, None);
    assert_eq!(usage.usages.limit_month_total.unwrap().used_ratio, 0.0056);
    assert_eq!(
        usage_transport.requests.lock().unwrap()[0].url(),
        "https://api.kimi.com/coding/v1/usages"
    );
}

#[test]
fn quota_requests_preserve_status_cancellation_and_invalid_data() {
    for status in [401, 403, 429, 503] {
        let transport = Transport::response(status, "{}");
        let target = target();
        let client = Client::new(&transport, &target).unwrap();
        assert_eq!(
            client.read_usage(&CancellationSource::new().token()),
            Err(RequestError::HttpStatus(status))
        );
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
    let transport = Transport::response(200, r#"{"usages":{"limit_5h":{"used_ratio":-1}}}"#);
    let target = target();
    let client = Client::new(&transport, &target).unwrap();
    assert_eq!(
        client.read_usage(&CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    let malformed_time = Transport::response(
        200,
        r#"{"usages":{"limit_5h":{"used_ratio":0.5,"reset_time":"soon"}}}"#,
    );
    assert_eq!(
        Client::new(&malformed_time, &target)
            .unwrap()
            .read_usage(&CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    let missing_usage = Transport::response(200, r#"{}"#);
    assert_eq!(
        Client::new(&missing_usage, &target)
            .unwrap()
            .read_usage(&CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert_eq!(
        client.read_usage(&cancelled.token()),
        Err(RequestError::Cancelled)
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
