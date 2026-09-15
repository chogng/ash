use super::*;
use ash_async_utils::CancellationSource;
use ash_core::UnsupportedBrowserCapability;
use ash_protocol::ToolCallId;
use serde_json::json;

#[test]
fn browser_tools_are_complete_strict_and_require_one_time_approval() {
    let service = BrowserToolService::new(Arc::new(UnsupportedBrowserCapability));
    let definitions = service.definitions();
    assert_eq!(definitions.len(), 10);
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
    let service = BrowserToolService::new(Arc::new(UnsupportedBrowserCapability));
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

fn call(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: ToolCallId::new(format!("{name}-call")).unwrap(),
        name: ToolName::new(name).unwrap(),
        arguments,
    }
}
