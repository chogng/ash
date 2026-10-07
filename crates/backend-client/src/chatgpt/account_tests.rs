use crate::RequestError;
use crate::chatgpt::test_support::target;
use crate::chatgpt::*;
use crate::test_support::Transport;
use async_utils::CancellationSource;
use serde_json::json;

#[test]
fn profile_distinguishes_missing_statistics_from_zero_and_empty_lists() {
    let target = target(BASE_URL);
    let token = CancellationSource::new().token();
    for stats in [
        json!({}),
        json!({"total_threads":null,"daily_usage_buckets":null}),
    ] {
        let client = Transport::response(200, &json!({"stats":stats}).to_string());
        let profile = Client::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_account_profile(&token)
            .unwrap();
        assert_eq!(profile.profile, None);
        assert_eq!(profile.metadata, None);
        assert_eq!(profile.stats.total_threads, None);
        assert_eq!(profile.stats.daily_usage_buckets, None);
        assert_eq!(profile.stats.top_invocations, None);
    }
    let client = Transport::response(
        200,
        r#"{"stats":{"total_threads":0,"lifetime_tokens":0,"daily_usage_buckets":[],"top_invocations":[]}}"#,
    );
    let stats = Client::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_account_profile(&token)
        .unwrap()
        .stats;
    assert_eq!(stats.total_threads, Some(0));
    assert_eq!(stats.lifetime_tokens, Some(0));
    assert_eq!(stats.daily_usage_buckets, Some(vec![]));
    assert_eq!(stats.top_invocations, Some(vec![]));
}

#[test]
fn profile_retains_identity_freshness_history_and_invocation_details() {
    let body = json!({
        "profile":{"display_name":"Reader","username":"reader"},
        "metadata":{"stats_as_of":"2026-09-21T00:00:00Z","stats_error":"partial"},
        "stats":{
            "lifetime_tokens":1234567890123_i64,"peak_daily_tokens":456789,
            "longest_running_turn_sec":3601,"current_streak_days":3,"longest_streak_days":9,
            "daily_usage_buckets":[{"start_date":"2026-09-20","tokens":0},{"start_date":"2026-09-21","tokens":456789}],
            "fast_mode_usage_percentage":12.5,"most_used_reasoning_effort":"high",
            "most_used_reasoning_effort_percentage":87.5,"unique_skills_used":2,"total_skills_used":7,
            "top_invocations":[{"type":"plugin","plugin_name":"review","usage_count":5},{"type":"skill","skill_name":"test","usage_count":2}]
        }
    });
    let client = Transport::response(200, &body.to_string());
    let target = target(BASE_URL);
    let profile = Client::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_account_profile(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(
        profile.profile.unwrap(),
        ProfileIdentity {
            display_name: Some("Reader".into()),
            username: Some("reader".into())
        }
    );
    assert_eq!(
        profile.metadata.unwrap(),
        ProfileMetadata {
            stats_as_of: Some("2026-09-21T00:00:00Z".into()),
            stats_error: Some("partial".into())
        }
    );
    let stats = profile.stats;
    assert_eq!(stats.peak_daily_tokens, Some(456789));
    assert_eq!(stats.longest_running_turn_sec, Some(3601));
    assert_eq!(stats.current_streak_days, Some(3));
    assert_eq!(stats.longest_streak_days, Some(9));
    assert_eq!(
        stats.fast_mode_usage_percentage.unwrap().as_f64(),
        Some(12.5)
    );
    assert_eq!(stats.most_used_reasoning_effort.as_deref(), Some("high"));
    assert_eq!(
        stats
            .most_used_reasoning_effort_percentage
            .unwrap()
            .as_f64(),
        Some(87.5)
    );
    assert_eq!(stats.unique_skills_used, Some(2));
    assert_eq!(stats.total_skills_used, Some(7));
    assert_eq!(
        stats.daily_usage_buckets.unwrap(),
        vec![
            TokenUsageBucket {
                start_date: "2026-09-20".into(),
                tokens: 0
            },
            TokenUsageBucket {
                start_date: "2026-09-21".into(),
                tokens: 456789
            }
        ]
    );
    assert_eq!(
        stats.top_invocations.unwrap(),
        vec![
            ProfileInvocation {
                kind: "plugin".into(),
                plugin_name: Some("review".into()),
                skill_name: None,
                usage_count: Some(5)
            },
            ProfileInvocation {
                kind: "skill".into(),
                plugin_name: None,
                skill_name: Some("test".into()),
                usage_count: Some(2)
            },
        ]
    );
}

#[test]
fn profile_rejects_invalid_statistics_without_leaking_the_profile() {
    let target = target(BASE_URL);
    for stats in [
        json!(null),
        json!({"total_threads":-1}),
        json!({"lifetime_tokens":"secret"}),
        json!({"daily_usage_buckets":[{"tokens":3}]}),
        json!({"top_invocations":[{"usage_count":1}]}),
    ] {
        let client = Transport::response(
            200,
            &json!({"profile":{"display_name":"private-user"},"stats":stats}).to_string(),
        );
        let error = Client::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_account_profile(&CancellationSource::new().token())
            .unwrap_err();
        assert_eq!(error, RequestError::InvalidResponse);
        assert!(!format!("{error:?} {error}").contains("private-user"));
    }
}

#[test]
fn account_formats_keep_workspace_order_and_reject_ambiguous_ids() {
    let token = CancellationSource::new().token();
    let target = target(BASE_URL);
    for accounts in [
        json!([
            {"id":"a", "plan_type":"future-plan", "name":"Personal"}, {"id":"b", "name":"Work"}, {"id":"c"}
        ]),
        json!({
            "a":{"account":{"account_id":"a","plan_type":"future-plan","name":"Personal"}},
            "b":{"account":{"account_id":"b","name":"Work"}},
            "c":{"account":{"account_id":"c"}}
        }),
    ] {
        let client = Transport::response(
            200,
            &json!({"accounts":accounts,"account_ordering":["b","a"],"default_account_id":"b"})
                .to_string(),
        );
        let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
        let accounts = backend.read_accounts(&token).unwrap();
        assert_eq!(
            accounts
                .accounts
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
        assert_eq!(
            accounts.accounts[1].plan_type.as_deref(),
            Some("future-plan")
        );
        assert_eq!(accounts.default_account_id.as_deref(), Some("b"));
    }
    for body in [
        r#"{"accounts":{"a":{"account":{"account_id":"b"}}}}"#,
        r#"{"accounts":[{"id":"a"},{"id":"a"}]}"#,
    ] {
        let client = Transport::response(200, body);
        assert_eq!(
            Client::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .read_accounts(&token),
            Err(RequestError::InvalidResponse)
        );
    }
}

#[test]
fn profile_preserves_large_counts_and_unknown_invocations() {
    let token = CancellationSource::new().token();
    let target = target(BASE_URL);
    let client = Transport::response(
        200,
        r#"{"profile":{"display_name":"Reader"},"stats":{"lifetime_tokens":1234567890123,"fast_mode_usage_percentage":12.5,"top_invocations":[{"type":"future","usage_count":2}]}}"#,
    );
    let profile = Client::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_account_profile(&token)
        .unwrap();
    assert_eq!(profile.stats.lifetime_tokens, Some(1234567890123));
    assert_eq!(profile.stats.total_threads, None);
    assert_eq!(profile.stats.top_invocations.unwrap()[0].kind, "future");
}
