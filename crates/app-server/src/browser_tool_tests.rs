use super::*;
use crate::browser_host::BrowserHost;
use crate::resource_store::ResourceStore;
use ash_async_utils::CancellationSource;
use ash_protocol::ToolCallId;
use serde_json::json;
use std::sync::Mutex;

#[test]
fn browser_tools_are_complete_strict_and_require_one_time_approval() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    let definitions = service.definitions();
    assert_eq!(definitions.len(), 18);
    assert!(definitions.iter().all(|definition| definition.strict));
    assert!(
        definitions
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );
    assert!(
        definitions
            .iter()
            .any(|definition| definition.name.as_str() == "browser_close")
    );

    let review = service
        .prepare(&call(
            "browser_open",
            json!({ "url": "https://example.test/" }),
        ))
        .unwrap();
    assert_eq!(review.action().kind(), &ActionKind::BrowserInteraction);
    assert_eq!(review.action().required_capabilities().iter().count(), 1);
    assert!(matches!(
        BrowserToolPolicy.decide(&review, &CancellationSource::new().token()),
        Ok(ExecutionDecision::AskUser(_))
    ));
}

#[test]
fn browser_tools_reject_privileged_urls_and_ambiguous_element_ids() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    for url in [
        "http://example.test/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:secret@example.test/",
    ] {
        assert!(
            service
                .prepare(&call("browser_open", json!({ "url": url })))
                .is_err()
        );
    }
    for node_id in ["0", "01", "+1", "active-element"] {
        assert!(
            service
                .prepare(&call(
                    "browser_click",
                    json!({ "target_id": "browser_target_1", "node_id": node_id }),
                ))
                .is_err()
        );
    }
}

#[test]
fn additional_browser_tools_validate_input_before_requesting_authority() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    for (name, arguments) in [
        (
            "browser_cdp",
            json!({"target_id":"page", "method":"Runtime.evaluate", "params_json":"{}", "session_id":null}),
        ),
        ("browser_cdp_events", json!({"target_id":"page"})),
        ("browser_cdp_close", json!({"target_id":"page"})),
        ("browser_list_pages", json!({})),
        ("browser_hover", json!({"target_id":"page", "node_id":"1"})),
        (
            "browser_drag",
            json!({"target_id":"page", "source_node_id":"1", "destination_node_id":"2"}),
        ),
        (
            "browser_handle_dialog",
            json!({"target_id":"page", "accept":true, "prompt_text":"answer"}),
        ),
        (
            "browser_run_playwright",
            json!({"target_id":"page", "code":"return await page.title();"}),
        ),
    ] {
        let review = service.prepare(&call(name, arguments)).unwrap();
        assert!(matches!(
            BrowserToolPolicy.decide(&review, &CancellationSource::new().token()),
            Ok(ExecutionDecision::AskUser(_))
        ));
    }
    for (name, arguments) in [
        (
            "browser_cdp",
            json!({"target_id":"page", "method":"Runtime.evaluate", "params_json":"[]", "session_id":null}),
        ),
        (
            "browser_cdp",
            json!({"target_id":"page", "method":"Runtime.evaluate.extra", "params_json":"{}", "session_id":null}),
        ),
        ("browser_list_pages", json!({"thread_id":"other"})),
        (
            "browser_drag",
            json!({"target_id":"page", "source_node_id":"1", "destination_node_id":"-2"}),
        ),
        (
            "browser_handle_dialog",
            json!({"target_id":"page", "accept":"true", "prompt_text":null}),
        ),
        (
            "browser_run_playwright",
            json!({"target_id":"page", "code":" "}),
        ),
        (
            "browser_run_playwright",
            json!({"target_id":"page", "code":"a".repeat(32769)}),
        ),
    ] {
        assert!(service.prepare(&call(name, arguments)).is_err());
    }
}

fn call(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: ToolCallId::new(format!("{name}-call")).unwrap(),
        name: ToolName::new(name).unwrap(),
        arguments,
    }
}

fn browser_host(resources: Arc<Mutex<ResourceStore>>) -> BrowserHost {
    BrowserHost::new(
        resources,
        Arc::new(crate::client_host::ClientHost::default()),
    )
}
