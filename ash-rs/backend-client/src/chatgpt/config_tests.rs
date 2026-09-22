use crate::RequestError;
use crate::chatgpt::test_support::target;
use crate::chatgpt::*;
use crate::test_support::Transport;
use async_utils::CancellationSource;
use http_client::HttpHeader;
use serde_json::json;

#[test]
fn config_preserves_enterprise_and_managed_layers_for_both_documents() {
    let fragment =
        |id: &str| json!({"id":id,"name":id,"contents":format!("# {id}\nvalue = '中文'\n")});
    let document = json!({"enterprise_managed":[fragment("enterprise")],"managed_layers":{"baseline":[fragment("first"),fragment("second")],"system_overlay":[fragment("system")]}});
    let client = Transport::response(
        200,
        &json!({"config_toml":document,"requirements_toml":document}).to_string(),
    );
    let target = target(BASE_URL);
    let config = Client::new(&client, &target, RouteStyle::Codex)
        .unwrap()
        .read_config_bundle(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(config.config_toml, config.requirements_toml);
    let document = config.config_toml.unwrap();
    assert_eq!(document.enterprise_managed.unwrap()[0].id, "enterprise");
    let layers = document.managed_layers.unwrap();
    assert_eq!(
        layers
            .baseline
            .iter()
            .map(|f| f.id.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert_eq!(layers.baseline[1].contents, "# second\nvalue = '中文'\n");
    assert_eq!(layers.system_overlay[0].id, "system");
}

#[test]
fn config_rejects_incomplete_fragments_and_layers() {
    let target = target(BASE_URL);
    for document in [
        json!({"enterprise_managed":[{"id":"fragment","name":"Name"}]}),
        json!({"managed_layers":{"baseline":[]}}),
        json!({"managed_layers":{"baseline":[],"system_overlay":[{"id":"fragment","contents":"private"}]}}),
    ] {
        for field in ["config_toml", "requirements_toml"] {
            let client = Transport::response(200, &json!({field:document}).to_string());
            assert_eq!(
                Client::new(&client, &target, RouteStyle::Codex)
                    .unwrap()
                    .read_config_bundle(&CancellationSource::new().token()),
                Err(RequestError::InvalidResponse)
            );
        }
    }
}

#[test]
fn settings_preserve_explicit_false_and_reject_non_boolean_values() {
    let target = target(BASE_URL);
    for (body, expected) in [
        ("{}", None),
        (r#"{"commit_attribution_enabled":null}"#, None),
        (r#"{"commit_attribution_enabled":false}"#, Some(false)),
        (r#"{"commit_attribution_enabled":true}"#, Some(true)),
    ] {
        let client = Transport::response(200, body);
        assert_eq!(
            Client::new(&client, &target, RouteStyle::ChatGpt)
                .unwrap()
                .read_user_settings(&CancellationSource::new().token())
                .unwrap()
                .commit_attribution_enabled,
            expected
        );
    }
    let client = Transport::response(200, r#"{"commit_attribution_enabled":"false"}"#);
    assert_eq!(
        Client::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_user_settings(&CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
}

#[test]
fn workspace_messages_keep_order_unknown_types_and_archive_timestamps() {
    let client = Transport::response(
        200,
        r#"{"messages":[{"message_id":"new","message_type":"future","message_body":"通知","created_at":"2026-09-21","archived_at":null},{"message_id":"old","message_type":"notice","message_body":"Old","created_at":"2026-09-01","archived_at":"2026-09-20"}]}"#,
    );
    let target = target(BASE_URL);
    let messages = Client::new(&client, &target, RouteStyle::ChatGpt)
        .unwrap()
        .list_workspace_messages(&CancellationSource::new().token())
        .unwrap()
        .messages;
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[0],
        WorkspaceMessage {
            message_id: "new".into(),
            message_type: "future".into(),
            message_body: "通知".into(),
            created_at: Some("2026-09-21".into()),
            archived_at: None
        }
    );
    assert_eq!(messages[1].message_id, "old");
    assert_eq!(messages[1].archived_at.as_deref(), Some("2026-09-20"));
}

#[test]
fn config_keeps_optional_data_and_layer_contents() {
    let token = CancellationSource::new().token();
    let target = target(BASE_URL);
    let client = Transport::response(
        200,
        r#"{"config_toml":{"managed_layers":{"baseline":[{"id":"base","name":"Base","contents":"x = 1"}],"system_overlay":[]}},"requirements_toml":null}"#,
    );
    let config = Client::new(&client, &target, RouteStyle::Codex)
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
fn settings_and_messages_override_cache_headers() {
    let mut target = target(BASE_URL);
    target
        .headers
        .push(HttpHeader::new("cache-control", "stale"));
    target
        .headers
        .push(HttpHeader::new("content-type", "text/plain"));
    let token = CancellationSource::new().token();
    let client = Transport::response(200, "{}");
    let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
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
    let client = Transport::response(
        200,
        r#"{"messages":[{"message_id":"m","message_type":"future","message_body":"Notice"}]}"#,
    );
    let backend = Client::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    assert_eq!(
        backend.list_workspace_messages(&token).unwrap().messages[0].message_type,
        "future"
    );
    assert!(
        client.requests.lock().unwrap()[0]
            .headers()
            .contains(&HttpHeader::new("Cache-Control", "no-store"))
    );
}
