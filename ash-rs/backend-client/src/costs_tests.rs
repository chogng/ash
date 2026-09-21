use crate::test_support::Client;
use crate::test_support::target;
use crate::*;
use ::client::ResolvedApiTarget;
use ::client::RetryPolicy;
use async_utils::CancellationSource;
use http_client::HttpHeader;
use http_client::HttpMethod;
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn thread_usage_keeps_unknown_amounts_and_checks_every_returned_identity() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(200, &json!({"threads":[
        {"thread_id":"a","estimated_usage_credits_micros":9007199254740993_i64,"groups":[{"model":"model","estimated_usage_credits_micros":123,"cached_input_tokens":5}]},
        {"thread_id":"b","estimated_usage_credits_micros":null}
    ]}).to_string());
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let rows = backend.read_thread_usage(&["a", "b", "c"], &token).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].estimated_usage_credits_micros,
        Some(9007199254740993)
    );
    assert_eq!(rows[0].estimated_usage_usd_micros, None);
    assert_eq!(
        rows[0].groups.as_ref().unwrap()[0].cached_input_tokens,
        Some(5)
    );
    assert_eq!(rows[1].estimated_usage_credits_micros, None);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(client.requests.lock().unwrap()[0].body())
            .unwrap(),
        json!({"thread_ids":["a","b","c"]})
    );
    for body in [
        json!({"threads":[{"thread_id":"other"}]}),
        json!({"threads":[{"thread_id":"a"},{"thread_id":"a"}]}),
    ] {
        let client = Client::response(200, &body.to_string());
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::Codex)
                .unwrap()
                .read_thread_usage(&["a"], &token),
            Err(RequestError::InvalidResponse)
        );
    }
}

#[test]
fn usage_queries_reject_empty_duplicate_overlapping_and_oversized_batches() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(200, r#"{"threads":[]}"#);
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let oversized = (0..101).map(|id| id.to_string()).collect::<Vec<_>>();
    let long_id = "a".repeat(513);
    for ids in [
        vec![],
        vec![""],
        vec!["a", "a"],
        vec![long_id.as_str()],
        oversized.iter().map(String::as_str).collect(),
    ] {
        assert_eq!(
            backend.read_thread_usage(&ids, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    let thread = |id: &str, children: Vec<String>| TaskUsageThread {
        thread_id: id.into(),
        created_at: None,
        descendant_thread_ids: children,
    };
    for threads in [
        vec![],
        vec![thread("a", vec!["b".into()]), thread("b", vec![])],
        vec![thread("a", vec!["child".into(), "child".into()])],
        vec![thread("a", vec!["".into()])],
        vec![thread("a", (0..1000).map(|id| id.to_string()).collect())],
        oversized.iter().map(|id| thread(id, vec![])).collect(),
    ] {
        assert_eq!(
            backend.read_task_usage(&threads, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert!(client.requests.lock().unwrap().is_empty());
    let hundred: Vec<_> = oversized.iter().take(100).map(String::as_str).collect();
    backend.read_thread_usage(&hundred, &token).unwrap();
    backend
        .read_task_usage(
            &[thread("root", (0..999).map(|id| id.to_string()).collect())],
            &token,
        )
        .unwrap();
    assert_eq!(client.requests.lock().unwrap().len(), 2);
}

#[test]
fn task_usage_preserves_decimal_balances_partial_results_and_descendant_scope() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let threads = [TaskUsageThread {
        thread_id: "root".into(),
        created_at: Some("2026-09-01T00:00:00Z".into()),
        descendant_thread_ids: vec!["child".into()],
    }];
    let row = json!({"thread_id":"root","data_status":"partial","usage_source":"backend","five_hour_limit_percent":0.125,"weekly_limit_percent":null,"balance_usage_credits":"123456789012345678.00000001","groups":[{"product_experience":"codex","model":"future-model","weekly_limit_percent":0.5}]});
    let client = Client::response(
        200,
        &json!({"data_as_of":"2026-09-22","threads":[row.clone()]}).to_string(),
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let usage = backend.read_task_usage(&threads, &token).unwrap();
    assert_eq!(usage.threads[0].data_status, TaskUsageStatus::Partial);
    assert_eq!(
        usage.threads[0].amounts.five_hour_limit_percent,
        Some(0.125)
    );
    assert_eq!(usage.threads[0].amounts.weekly_limit_percent, None);
    assert_eq!(
        usage.threads[0].amounts.balance_usage_credits.as_deref(),
        Some("123456789012345678.00000001")
    );
    assert_eq!(
        usage.threads[0].groups[0].amounts.balance_usage_credits,
        None
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(client.requests.lock().unwrap()[0].body())
            .unwrap(),
        json!({"threads":[{"thread_id":"root","created_at":"2026-09-01T00:00:00Z","descendant_thread_ids":["child"]}]})
    );
    let mut child = row.clone();
    child["thread_id"] = json!("child");
    for rows in [json!([row.clone(), row]), json!([child])] {
        let client = Client::response(200, &json!({"threads":rows}).to_string());
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .read_task_usage(&threads, &token),
            Err(RequestError::InvalidResponse)
        );
    }
}

#[test]
fn task_usage_rejects_invalid_credit_amounts_in_totals_and_groups() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let query = [TaskUsageThread {
        thread_id: "root".into(),
        created_at: None,
        descendant_thread_ids: Vec::new(),
    }];
    for invalid in [
        "NaN",
        "inf",
        "1..0",
        "",
        " 1",
        "1e",
        "1e999999999999",
        "--1",
    ] {
        for field in ["total", "group"] {
            let mut row = json!({"thread_id":"root","data_status":"available","usage_source":"plan_and_credits","groups":[{}]});
            let amounts = if field == "total" {
                &mut row
            } else {
                &mut row["groups"][0]
            };
            amounts["balance_usage_credits"] = json!(invalid);
            let client = Client::response(200, &json!({"threads":[row]}).to_string());
            let result = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .read_task_usage(&query, &token);
            assert_eq!(
                result,
                Err(RequestError::InvalidResponse),
                "{field}: {invalid}"
            );
        }
    }
}

#[test]
fn task_usage_preserves_signed_decimal_and_exponent_notation() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let query = [TaskUsageThread {
        thread_id: "root".into(),
        created_at: None,
        descendant_thread_ids: Vec::new(),
    }];
    for amount in [
        "0",
        "-0.000000000000000001",
        "+1.00",
        ".125",
        "1.",
        "1e-20",
        "-1E+3",
        "1e400",
    ] {
        let client = Client::response(200, &json!({"threads":[{"thread_id":"root","data_status":"available","usage_source":"plan_and_credits","balance_usage_credits":amount,"groups":[]}]}).to_string());
        let response = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_task_usage(&query, &token)
            .unwrap();
        assert_eq!(
            response.threads[0].amounts.balance_usage_credits.as_deref(),
            Some(amount)
        );
    }
}

#[test]
fn task_usage_requires_finite_numeric_percentages_without_clamping() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let query = [TaskUsageThread {
        thread_id: "root".into(),
        created_at: None,
        descendant_thread_ids: Vec::new(),
    }];
    for location in ["total", "group"] {
        for name in ["five_hour_limit_percent", "weekly_limit_percent"] {
            for number in ["1e400", "-1e400", "\"NaN\"", "true"] {
                let mut row = json!({"thread_id":"root","data_status":"available","usage_source":"plan_and_credits","groups":[{}]});
                let amounts = if location == "total" {
                    &mut row
                } else {
                    &mut row["groups"][0]
                };
                amounts[name] = json!("number-to-replace");
                let body = json!({"threads":[row]})
                    .to_string()
                    .replace("\"number-to-replace\"", number);
                let client = Client::response(200, &body);
                assert_eq!(
                    BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                        .unwrap()
                        .read_task_usage(&query, &token),
                    Err(RequestError::InvalidResponse),
                    "{location}.{name}: {number}"
                );
            }
        }
    }
    let client = Client::response(
        200,
        r#"{"threads":[{"thread_id":"root","data_status":"available","usage_source":"plan_and_credits","five_hour_limit_percent":150.25,"groups":[{"weekly_limit_percent":0.125}]}]}"#,
    );
    let response = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_task_usage(&query, &token)
        .unwrap();
    assert_eq!(
        response.threads[0].amounts.five_hour_limit_percent,
        Some(150.25)
    );
    assert_eq!(
        response.threads[0].groups[0].amounts.weekly_limit_percent,
        Some(0.125)
    );
}

#[test]
fn chatgpt_turn_costs_preserve_settlement_and_validate_thread_and_turn_pairs() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let threads = BTreeMap::from([("thread".into(), vec!["turn".into(), "pending".into()])]);
    let row = json!({"thread_id":"thread","turns":[{"turn_id":"turn","estimated_usage_usd_micros":7,"settled_response_ids":["response-1"]},{"turn_id":"pending"}]});
    let client = Client::response(200, &json!({"threads":[row.clone()]}).to_string());
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let costs = backend.query_chatgpt_turn_costs(&threads, &token).unwrap();
    assert_eq!(
        costs[0].turns[0].settled_response_ids.as_ref().unwrap(),
        &["response-1"]
    );
    assert_eq!(costs[0].turns[1].estimated_usage_usd_micros, None);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(client.requests.lock().unwrap()[0].body())
            .unwrap(),
        json!({"threads":[{"thread_id":"thread","turn_ids":["turn","pending"]}],"include_settled_response_ids":true})
    );
    for body in [
        json!({"threads":[row.clone(),row]}),
        json!({"threads":[{"thread_id":"other","turns":[]}]}),
        json!({"threads":[{"thread_id":"thread","turns":[{"turn_id":"other"}]}]}),
        json!({"threads":[{"thread_id":"thread","turns":[{"turn_id":"turn"},{"turn_id":"turn"}]}]}),
    ] {
        let client = Client::response(200, &body.to_string());
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .query_chatgpt_turn_costs(&threads, &token),
            Err(RequestError::InvalidResponse)
        );
    }
    for threads in [
        BTreeMap::new(),
        BTreeMap::from([("thread".into(), vec![])]),
        BTreeMap::from([("thread".into(), vec!["turn".into(), "turn".into()])]),
    ] {
        assert_eq!(
            backend.query_chatgpt_turn_costs(&threads, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn api_key_costs_use_the_explicit_origin_auth_and_provider_scope() {
    let target = ResolvedApiTarget::new(
        "https://billing.example.test/v1",
        vec![
            HttpHeader::new("Authorization", "Bearer api-key"),
            HttpHeader::new("OpenAI-Organization", "org"),
            HttpHeader::new("OpenAI-Project", "project"),
        ],
    );
    let token = CancellationSource::new().token();
    let client = Client::response(
        200,
        r#"{"turns":[{"turn_id":"priced","status":"priced","total_usd":"0.000000123456789","responses":[{"response_id":"response","total_usd":"0.000000123456789"}]},{"turn_id":"pending","status":"pending"}]}"#,
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::Codex).unwrap();
    let costs = backend
        .query_api_key_turn_costs(&["priced".into(), "pending".into()], &token)
        .unwrap();
    assert_eq!(costs[0].total_usd.as_deref(), Some("0.000000123456789"));
    assert_eq!(costs[1].status, ApiKeyTurnCostStatus::Pending);
    assert_eq!(costs[1].total_usd, None);
    let requests = client.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://billing.example.test/v1/analytics/codex/turn-costs"
    );
    assert_eq!(requests[0].method(), HttpMethod::Post);
    assert_eq!(requests[0].retry_policy(), RetryPolicy::never());
    for header in &target.headers {
        assert!(requests[0].headers().contains(header));
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
        json!({"turn_ids":["priced","pending"]})
    );
    drop(requests);
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert_eq!(
        backend.query_api_key_turn_costs(&["priced".into()], &cancelled.token()),
        Err(RequestError::Cancelled)
    );
    for ids in [vec![], vec!["".into()], vec!["same".into(), "same".into()]] {
        assert_eq!(
            backend.query_api_key_turn_costs(&ids, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    for (status, body, expected) in [
        (401, "private key", RequestError::HttpStatus(401)),
        (200, "private malformed data", RequestError::InvalidResponse),
        (
            200,
            r#"{"turns":[{"turn_id":"other","status":"pending"}]}"#,
            RequestError::InvalidResponse,
        ),
        (
            200,
            r#"{"turns":[{"turn_id":"priced","status":"pending"},{"turn_id":"priced","status":"pending"}]}"#,
            RequestError::InvalidResponse,
        ),
    ] {
        let client = Client::response(status, body);
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::Codex)
                .unwrap()
                .query_api_key_turn_costs(&["priced".into()], &token),
            Err(expected)
        );
    }
}
