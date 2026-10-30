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
    assert_eq!(definitions.len(), 20);
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
fn canvas_open_validates_identity_and_uses_the_existing_browser_review() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    let valid = json!({"url":"https://example.test/app", "canvas":{"instance_id":"preview-1", "title":"Preview"}});
    let request = service
        .materialize(&call("browser_open", valid.clone()))
        .unwrap();
    assert!(matches!(
        request,
        BrowserToolRequest::Open {
            canvas: Some(_),
            ..
        }
    ));
    assert_eq!(
        service
            .prepare(&call("browser_open", valid))
            .unwrap()
            .action()
            .kind(),
        &ActionKind::BrowserInteraction
    );
    for canvas in [
        json!({"instance_id":"../other", "title":"Preview"}),
        json!({"instance_id":"preview", "title":" "}),
        json!({"instance_id":"preview", "title":"Preview", "thread_id":"other"}),
    ] {
        assert!(
            service
                .prepare(&call(
                    "browser_open",
                    json!({"url":"https://example.test/app", "canvas":canvas})
                ))
                .is_err()
        );
    }
}

#[test]
fn registered_canvas_tools_admit_only_type_identity_without_model_supplied_session_or_source() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    assert!(matches!(
        service
            .materialize(&call("canvas_list", json!({})))
            .unwrap(),
        BrowserToolRequest::CanvasList
    ));
    let valid =
        json!({"extension_id":"fixture.extension", "canvas_id":"board", "instance_id":"preview"});
    assert!(matches!(
        service
            .materialize(&call("canvas_open", valid.clone()))
            .unwrap(),
        BrowserToolRequest::CanvasOpen(_)
    ));
    for (key, value) in [
        ("session_id", "forged"),
        ("thread_id", "forged"),
        ("url", "https://forged.test"),
    ] {
        let mut arguments = valid.clone();
        arguments[key] = json!(value);
        assert!(
            service
                .materialize(&call("canvas_open", arguments))
                .is_err()
        );
    }
    for invalid in ["", "../board", "board/other", "board?token=secret"] {
        let mut arguments = valid.clone();
        arguments["canvas_id"] = json!(invalid);
        assert!(
            service
                .materialize(&call("canvas_open", arguments))
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
        Arc::new(|_, _, _, _| Err(core_api::BrowserError::CapabilityUnavailable)),
    )
}

#[test]
fn browser_file_upload_review_includes_each_path_without_granting_file_access() {
    let service = BrowserToolService::new(Arc::new(browser_host(Arc::new(Mutex::new(
        ResourceStore::default(),
    )))));
    let review = service.prepare(&call("browser_cdp", json!({
        "target_id":"page", "method":"DOM.setFileInputFiles",
        "params_json":r#"{"files":["/project/allowed.txt","/private/secret.txt"],"backendNodeId":1}"#,
        "session_id":null,
    }))).unwrap();
    assert_eq!(review.action().required_capabilities().iter().count(), 3);
    assert!(matches!(
        BrowserToolPolicy.decide(&review, &CancellationSource::new().token()),
        Ok(ExecutionDecision::AskUser(_))
    ));
}
