use super::*;
use crate::resource_store::ResourceStore;
use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::common::BrowserCapability as ClientBrowserCapability;
use ash_async_utils::CancellationSource;
use core_api::BrowserCapability;
use core_api::BrowserObserveRequest;
use core_api::CreateBrowserTargetRequest;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

#[test]
fn browser_requests_bind_targets_and_resources_to_the_exact_connection() {
    let resources = Arc::new(Mutex::new(ResourceStore::default()));
    let host = Arc::new(BrowserHost::new(Arc::clone(&resources)));
    let outbound = NotificationQueue::default();
    host.register(
        7,
        ClientBrowserCapability {
            version: 1,
            observe: true,
            input: true,
        },
        outbound.clone(),
    );

    let create_host = Arc::clone(&host);
    let create = thread::spawn(move || {
        create_host.create_target(
            CreateBrowserTargetRequest {
                url: "https://example.test/".into(),
            },
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "browser/create");
    assert_eq!(request["params"]["url"], "https://example.test/");
    let request_id = request["id"].as_str().unwrap();
    assert!(
        host.handle_response(
            8,
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "targetId": "browser_target_stolen" },
            }),
        )
        .is_err()
    );
    assert!(
        host.handle_response(
            7,
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "targetId": "browser_target_test" },
            }),
        )
        .unwrap()
    );
    assert!(
        host.handle_response(
            7,
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "targetId": "browser_target_duplicate" },
            }),
        )
        .is_err()
    );
    let target = create.join().unwrap().unwrap().target_id;

    let observe_host = Arc::clone(&host);
    let observe_target = target.clone();
    let observe = thread::spawn(move || {
        observe_host.observe(
            BrowserObserveRequest {
                target_id: observe_target,
                include_accessibility_tree: true,
                include_dom_snapshot: false,
                include_screenshot: true,
            },
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "browser/observe");
    let request_id = request["id"].as_str().unwrap();
    host.handle_response(
        7,
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "targetId": target.0,
                "url": "https://example.test/",
                "title": "Example",
                "loading": false,
                "accessibilityTree": "{}",
                "screenshot": {
                    "mimeType": "image/png",
                    "dataBase64": "iVBORw0KGgo=",
                    "decodedLength": 8
                }
            },
        }),
    )
    .unwrap();
    let observation = observe.join().unwrap().unwrap();
    let screenshot = observation.screenshot.unwrap();
    assert_eq!(screenshot.mime_type, "image/png");
    assert_eq!(screenshot.size, 8);
    assert!(
        resources
            .lock()
            .unwrap()
            .metadata(7, &screenshot.resource_id)
            .is_ok()
    );
    assert!(
        resources
            .lock()
            .unwrap()
            .metadata(8, &screenshot.resource_id)
            .is_err()
    );
}

#[test]
fn disconnect_fails_pending_requests_and_forgets_target_ownership() {
    let resources = Arc::new(Mutex::new(ResourceStore::default()));
    let host = Arc::new(BrowserHost::new(resources));
    let outbound = NotificationQueue::default();
    host.register(
        3,
        ClientBrowserCapability {
            version: 1,
            observe: true,
            input: true,
        },
        outbound.clone(),
    );
    let request_host = Arc::clone(&host);
    let request = thread::spawn(move || {
        request_host.create_target(
            CreateBrowserTargetRequest {
                url: "about:blank".into(),
            },
            &CancellationSource::new().token(),
        )
    });
    let _ = next_request(&outbound);
    host.unregister(3);
    assert_eq!(
        request.join().unwrap(),
        Err(BrowserError::CapabilityUnavailable)
    );
}

#[test]
fn cancellation_retires_the_request_and_accepts_its_late_terminal_response() {
    let resources = Arc::new(Mutex::new(ResourceStore::default()));
    let host = Arc::new(BrowserHost::new(resources));
    let outbound = NotificationQueue::default();
    host.register(
        11,
        ClientBrowserCapability {
            version: 1,
            observe: true,
            input: true,
        },
        outbound.clone(),
    );
    let source = CancellationSource::new();
    let token = source.token();
    let request_host = Arc::clone(&host);
    let request = thread::spawn(move || {
        request_host.create_target(
            CreateBrowserTargetRequest {
                url: "about:blank".into(),
            },
            &token,
        )
    });
    let outbound_request = next_request(&outbound);
    let request_id = outbound_request["id"].as_str().unwrap().to_owned();

    source.cancel();
    assert!(matches!(
        request.join().unwrap(),
        Err(BrowserError::Cancelled(_))
    ));
    let cancellation = next_request(&outbound);
    assert_eq!(cancellation["method"], "$/cancelRequest");
    assert_eq!(cancellation["params"]["id"], request_id);
    assert!(
        host.handle_response(
            11,
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": { "code": -32800, "message": "Request cancelled", "data": null },
            }),
        )
        .unwrap()
    );
}

fn next_request(outbound: &NotificationQueue) -> Value {
    let listener = outbound.listener();
    assert!(listener.wait());
    listener.drain().into_iter().next().unwrap()
}
