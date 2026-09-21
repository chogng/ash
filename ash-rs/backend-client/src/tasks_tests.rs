use crate::test_support::Client;
use crate::test_support::target;
use crate::*;
use async_utils::CancellationSource;
use serde_json::json;

#[test]
fn completed_task_fixture_extracts_only_user_and_assistant_text_and_the_pr_diff() {
    let client = Client::response(200, include_str!("../tests/fixtures/task_completed.json"));
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let details = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_task("completed", &CancellationSource::new().token())
        .unwrap();
    assert_eq!(
        details.user_text_prompt().as_deref(),
        Some("Review the parser\n\n保留换行\nand Unicode")
    );
    assert_eq!(
        details.assistant_text_messages(),
        ["Updated parser", "Tests passed", "Checked edge cases"]
    );
    assert_eq!(
        details.unified_diff(),
        Some(
            "diff --git a/parser.rs b/parser.rs\n--- a/parser.rs\n+++ b/parser.rs\n@@ -1 +1 @@\n-old\n+new\n"
        )
    );
    assert_eq!(details.assistant_error_message(), None);
}

#[test]
fn failed_task_fixture_preserves_error_without_inventing_content() {
    let client = Client::response(200, include_str!("../tests/fixtures/task_failed.json"));
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let details = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_task("failed", &CancellationSource::new().token())
        .unwrap();
    assert!(details.task.archived);
    assert_eq!(details.user_text_prompt(), None);
    assert!(details.assistant_text_messages().is_empty());
    assert_eq!(details.unified_diff(), None);
    assert_eq!(
        details.assistant_error_message().as_deref(),
        Some("EXECUTION_FAILED: Environment stopped")
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
