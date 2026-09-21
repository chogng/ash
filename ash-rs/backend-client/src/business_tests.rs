use super::*;
use async_utils::CancellationToken;
use serde_json::json;
use std::collections::BTreeMap;

type Operation = fn(&BackendClient<'_>, &CancellationToken) -> Result<(), RequestError>;

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
        (
            "accounts/send_add_credits_nudge_email",
            HttpMethod::Post,
            "",
            |backend, token| backend.send_credit_nudge(CreditNudge::Credits, token),
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
            let client = Client::response(200, body);
            let backend = BackendClient::new(&client, &target, route).unwrap();
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
                let client = Client::response(status, "private account response");
                let backend = BackendClient::new(&client, &target, route).unwrap();
                let error = run(&backend, &token).unwrap_err();
                assert_eq!(error, RequestError::HttpStatus(status), "{path}");
                assert!(!format!("{error:?} {error}").contains("private"));
                assert_eq!(client.requests.lock().unwrap().len(), 1);
            }
            if *path != "accounts/send_add_credits_nudge_email" {
                let client = Client::response(200, "<html>private</html>");
                let backend = BackendClient::new(&client, &target, route).unwrap();
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

#[test]
fn accounts_profiles_and_configuration_keep_optional_data_and_order() {
    let token = CancellationSource::new().token();
    let target = target(CHATGPT_BACKEND_BASE_URL);
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
        let client = Client::response(
            200,
            &json!({"accounts":accounts,"account_ordering":["b","a"],"default_account_id":"b"})
                .to_string(),
        );
        let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
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
        let client = Client::response(200, body);
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .read_accounts(&token),
            Err(RequestError::InvalidResponse)
        );
    }
    let client = Client::response(
        200,
        r#"{"profile":{"display_name":"Reader"},"stats":{"lifetime_tokens":1234567890123,"fast_mode_usage_percentage":12.5,"top_invocations":[{"type":"future","usage_count":2}]}}"#,
    );
    let profile = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_account_profile(&token)
        .unwrap();
    assert_eq!(profile.stats.lifetime_tokens, Some(1234567890123));
    assert_eq!(profile.stats.total_threads, None);
    assert_eq!(profile.stats.top_invocations.unwrap()[0].kind, "future");
    let client = Client::response(
        200,
        r#"{"config_toml":{"managed_layers":{"baseline":[{"id":"base","name":"Base","contents":"x = 1"}],"system_overlay":[]}},"requirements_toml":null}"#,
    );
    let config = BackendClient::new(&client, &target, RouteStyle::Codex)
        .unwrap()
        .read_config_bundle(&token)
        .unwrap();
    assert_eq!(config.requirements_toml, None);
    assert_eq!(
        config.config_toml.unwrap().managed_layers.unwrap().baseline[0].contents,
        "x = 1"
    );
}

#[test]
fn settings_messages_and_email_have_exact_headers_and_bodies() {
    let mut target = target(CHATGPT_BACKEND_BASE_URL);
    target
        .headers
        .push(HttpHeader::new("cache-control", "stale"));
    target
        .headers
        .push(HttpHeader::new("content-type", "text/plain"));
    let token = CancellationSource::new().token();
    let client = Client::response(200, "{}");
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    assert_eq!(
        backend
            .read_user_settings(&token)
            .unwrap()
            .commit_attribution_enabled,
        None
    );
    let requests = client.requests.lock().unwrap();
    let cache: Vec<_> = requests[0]
        .headers()
        .iter()
        .filter(|header| header.name().eq_ignore_ascii_case("cache-control"))
        .collect();
    assert_eq!(
        cache,
        [&HttpHeader::new("Cache-Control", "no-cache, no-store")]
    );
    drop(requests);
    let client = Client::response(
        200,
        r#"{"messages":[{"message_id":"m","message_type":"future","message_body":"Notice"}]}"#,
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    assert_eq!(
        backend.list_workspace_messages(&token).unwrap().messages[0].message_type,
        "future"
    );
    assert!(
        client.requests.lock().unwrap()[0]
            .headers()
            .contains(&HttpHeader::new("Cache-Control", "no-store"))
    );
    let client = Client::response(204, "");
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    backend
        .send_credit_nudge(CreditNudge::UsageLimit, &token)
        .unwrap();
    let requests = client.requests.lock().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
        json!({"credit_type":"usage_limit"})
    );
    assert_eq!(
        requests[0]
            .headers()
            .iter()
            .filter(|header| header.name().eq_ignore_ascii_case("content-type"))
            .count(),
        1
    );
}

#[test]
fn task_queries_encode_components_and_preserve_turn_content() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(
        200,
        r#"{"items":[{"id":"task-1","title":"Task","archived":false,"has_unread_turn":true}],"cursor":"next"}"#,
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let list = backend
        .list_tasks(
            &TaskListQuery {
                limit: Some(10),
                task_filter: Some("mine / shared"),
                cursor: Some("next=page"),
                environment_id: Some("env&one"),
            },
            &token,
        )
        .unwrap();
    assert_eq!(list.cursor.as_deref(), Some("next"));
    assert!(list.items[0].has_unread_turn);
    assert_eq!(
        client.requests.lock().unwrap()[0].url(),
        "https://chatgpt.com/backend-api/wham/tasks/list?limit=10&task_filter=mine+%2F+shared&cursor=next%3Dpage&environment_id=env%26one"
    );
    let body = json!({
        "task":{"id":"task /?#%","title":"Task","archived":false,"external_pull_requests":[]},
        "current_user_turn":{"input_items":[{"type":"message","role":"user","content":["One",{"content_type":"text","text":"Two"}]}]},
        "current_assistant_turn":{"output_items":[{"type":"message","content":["Done"]},{"type":"pr","output_diff":{"diff":"pr diff"}}],"worklog":{"messages":[{"author":{"role":"assistant"},"content":{"parts":["Log"]}}]},"error":{"code":"FAILED","message":"Detail"}},
        "current_diff_task_turn":{"output_items":[{"type":"output_diff","diff":"selected diff"}]}
    });
    let client = Client::response(200, &body.to_string());
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let details = backend.read_task("task /?#%", &token).unwrap();
    assert_eq!(details.user_text_prompt().as_deref(), Some("One\n\nTwo"));
    assert_eq!(details.assistant_text_messages(), ["Done", "Log"]);
    assert_eq!(details.unified_diff(), Some("selected diff"));
    assert_eq!(
        details.assistant_error_message().as_deref(),
        Some("FAILED: Detail")
    );
    assert_eq!(
        client.requests.lock().unwrap()[0].url(),
        "https://chatgpt.com/backend-api/wham/tasks/task%20%2F%3F%23%25"
    );
    for id in ["", " ", ".", ".."] {
        assert_eq!(
            backend.read_task(id, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    let client = Client::response(
        200,
        r#"{"sibling_turns":[{"id":"turn-2","turn_status":"completed","output_items":null}]}"#,
    );
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    assert_eq!(
        backend
            .list_sibling_turns("task/1", "turn?1", &token)
            .unwrap()
            .sibling_turns[0]
            .turn_status
            .as_deref(),
        Some("completed")
    );
    assert!(
        client.requests.lock().unwrap()[0]
            .url()
            .ends_with("/tasks/task%2F1/turns/turn%3F1/sibling_turns")
    );
}

#[test]
fn task_details_and_attempts_preserve_metadata_used_for_display_and_ordering() {
    let token = CancellationSource::new().token();
    for route in [RouteStyle::Codex, RouteStyle::ChatGpt] {
        let target = target(CHATGPT_BACKEND_BASE_URL);
        let body = json!({
            "task": {
                "id":"task-1", "title":"Review parser", "archived":false,
                "created_at":1750000000.125, "updated_at":1750000020.5,
                "environment_id":"env-1", "is_review":true,
                "has_generated_title":true, "current_turn_id":"turn-2", "has_unread_turn":true,
                "denormalized_metadata":{"branch":"main"},
                "task_status_display":{"environment_label":"workspace"},
                "external_pull_requests":[{"id":"pr-1","assistant_turn_id":"turn-2","codex_updated_sha":"abc","pull_request":{"number":42,"url":"https://example.test/pull/42","state":"open","merged":false,"mergeable":true}}]
            },
            "task_status_display":{"latest_turn_status_display":{"turn_status":"completed"}},
            "current_assistant_turn":{"id":"turn-2","created_at":1750000010.25}
        });
        let client = Client::response(200, &body.to_string());
        let backend = BackendClient::new(&client, &target, route).unwrap();
        let details = backend.read_task("task-1", &token).unwrap();
        assert_eq!(details.task.title, "Review parser");
        assert_eq!(details.task.created_at, Some(1750000000.125));
        assert_eq!(details.task.updated_at, Some(1750000020.5));
        assert_eq!(details.task.environment_id.as_deref(), Some("env-1"));
        assert_eq!(details.task.is_review, Some(true));
        assert_eq!(
            details.task.denormalized_metadata.as_ref().unwrap()["branch"],
            "main"
        );
        assert_eq!(
            details.task.external_pull_requests[0].pull_request.number,
            42
        );
        assert_eq!(
            details.task.task_status_display.as_ref().unwrap()["environment_label"],
            "workspace"
        );
        assert_eq!(
            details.task_status_display.as_ref().unwrap()["latest_turn_status_display"]["turn_status"],
            "completed"
        );
        assert_eq!(
            details.current_assistant_turn.as_ref().unwrap().created_at,
            Some(1750000010.25)
        );

        let client = Client::response(
            200,
            r#"{"sibling_turns":[{"id":"turn-2","created_at":1750000010.25,"turn_status":"completed"},{"id":"turn-3","created_at":null,"turn_status":"running"}]}"#,
        );
        let backend = BackendClient::new(&client, &target, route).unwrap();
        let attempts = backend
            .list_sibling_turns("task-1", "turn-1", &token)
            .unwrap();
        assert_eq!(attempts.sibling_turns[0].created_at, Some(1750000010.25));
        assert_eq!(attempts.sibling_turns[1].created_at, None);
    }
}

#[test]
fn task_details_reject_missing_metadata_and_other_task_identity() {
    let token = CancellationSource::new().token();
    let target = target(CHATGPT_BACKEND_BASE_URL);
    for body in [
        "{}",
        r#"{"task":null}"#,
        r#"{"task":{"id":"other","title":"Task","archived":false,"external_pull_requests":[]}}"#,
        r#"{"task":{"id":"task-1","archived":false,"external_pull_requests":[]}}"#,
    ] {
        let client = Client::response(200, body);
        let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
        assert_eq!(
            backend.read_task("task-1", &token),
            Err(RequestError::InvalidResponse)
        );
    }
}

#[test]
fn task_creation_preserves_payload_and_requires_an_unambiguous_task_id() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let payload = json!({"environment_id":"env-1","input_items":[{"type":"message","content":["Implement"]}],"metadata":{"best_of_n":2}});
    for body in [r#"{"task":{"id":"new"}}"#, r#"{"id":"new"}"#] {
        let client = Client::response(201, body);
        let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
        assert_eq!(
            backend
                .create_task(payload.as_object().unwrap(), &token)
                .unwrap(),
            "new"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(client.requests.lock().unwrap()[0].body())
                .unwrap(),
            payload
        );
    }
    for body in [
        "{}",
        r#"{"id":""}"#,
        r#"{"task":{"id":"one"},"id":"two"}"#,
        r#"{"task":{"id":42},"id":"two"}"#,
    ] {
        let client = Client::response(201, body);
        assert_eq!(
            BackendClient::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .create_task(payload.as_object().unwrap(), &token),
            Err(RequestError::InvalidResponse)
        );
    }
}
