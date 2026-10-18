use super::*;
use serde_json::json;

#[test]
fn browser_session_metadata_has_no_daemon_authority() {
    let session = WebSessionInfo {
        token: "a".repeat(64),
        workspace_id: "workspace".into(),
        workspace_root: "/workspace".into(),
        workspace: WebWorkspaceState {
            id: "workspace".into(),
            configuration: None,
            folders: vec![WebWorkspaceFolder {
                id: "workspace".into(),
                path: "/workspace".into(),
                name: None,
            }],
        },
    };
    let value = serde_json::to_value(session).unwrap();
    assert_eq!(
        value,
        json!({ "token": "a".repeat(64), "workspaceId": "workspace", "workspaceRoot": "/workspace", "workspace": { "id": "workspace", "configuration": null, "folders": [{ "id": "workspace", "path": "/workspace", "name": null }] } })
    );
    for name in ["directoryGrantsHost", "dirPermissionsHost"] {
        let mut injected = value.clone();
        injected[name] = json!(true);
        assert!(serde_json::from_value::<WebSessionInfo>(injected).is_err());
    }
}

#[test]
fn browser_launch_contract_rejects_unknown_authority_and_invalid_ports() {
    for value in [
        json!({ "leaseId": ([0; 32]), "port": 65536, "assets": null, "origin": null }),
        json!({ "leaseId": ([0; 32]), "port": 0, "assets": null, "origin": null, "profileRoot": "/another-profile" }),
    ] {
        assert!(serde_json::from_value::<WebLaunchOptions>(value).is_err());
    }
    let info = WebListenInfo {
        endpoint: "http://127.0.0.1:5174/".into(),
        ticket: "b".repeat(64),
        pid: 42,
    };
    let value = serde_json::to_value(info).unwrap();
    assert_eq!(
        value,
        json!({ "endpoint": "http://127.0.0.1:5174/", "ticket": "b".repeat(64), "pid": 42 })
    );
}

#[test]
fn web_launch_lease_is_required_and_has_a_fixed_identity() {
    let options = WebLaunchOptions {
        lease_id: [7; 32],
        port: 0,
        assets: None,
        origin: None,
    };
    let mut value = serde_json::to_value(&options).unwrap();
    assert_eq!(
        serde_json::from_value::<WebLaunchOptions>(value.clone()).unwrap(),
        options
    );
    value["leaseId"] = json!([7]);
    assert!(serde_json::from_value::<WebLaunchOptions>(value.clone()).is_err());
    value.as_object_mut().unwrap().remove("leaseId");
    assert!(serde_json::from_value::<WebLaunchOptions>(value).is_err());
}

#[test]
fn workspace_selection_requires_explicit_approval_and_strict_fields() {
    let request = WebWorkspaceOpenRequest {
        path: "/chosen".into(),
        approved: true,
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value, json!({ "path": "/chosen", "approved": true }));
    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove("approved");
    assert!(serde_json::from_value::<WebWorkspaceOpenRequest>(missing).is_err());
    let mut injected = value;
    injected["directoryGrantsHost"] = json!(true);
    assert!(serde_json::from_value::<WebWorkspaceOpenRequest>(injected).is_err());
}

#[test]
fn inbound_host_record_is_strict_and_keeps_the_web_ticket_private() {
    let value = json!({
        "relayHost": "ash-relay", "relayPort": 43123,
        "web": { "endpoint": "http://127.0.0.1:5174/", "ticket": "b".repeat(64), "pid": 42 }
    });
    let info = serde_json::from_value::<RemoteTunnelHostInfo>(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(info).unwrap(), value);
    for injected in [
        json!({ "relayHost": "ash-relay", "relayPort": 65536, "web": value["web"] }),
        json!({ "relayHost": "ash-relay", "relayPort": 43123, "web": value["web"], "profileRoot": "/other" }),
    ] {
        assert!(serde_json::from_value::<RemoteTunnelHostInfo>(injected).is_err());
    }
}

#[test]
fn workspace_transactions_are_tagged_and_cannot_inject_product_host_authority() {
    let apply = json!({ "operation": "apply", "transaction": "11111111-1111-4111-8111-111111111111", "configuration": null, "folders": [{ "name": "Work", "path": "/work" }], "approved": true });
    assert!(matches!(
        serde_json::from_value::<WebWorkspaceUpdateRequest>(apply.clone()).unwrap(),
        WebWorkspaceUpdateRequest::Apply { .. }
    ));
    let finish = json!({ "operation": "finish", "transaction": "11111111-1111-4111-8111-111111111111", "accepted": false });
    assert!(matches!(
        serde_json::from_value::<WebWorkspaceUpdateRequest>(finish.clone()).unwrap(),
        WebWorkspaceUpdateRequest::Finish {
            accepted: false,
            ..
        }
    ));
    for mut value in [apply, finish] {
        value["directoryGrantsHost"] = json!(true);
        assert!(serde_json::from_value::<WebWorkspaceUpdateRequest>(value).is_err());
    }
    assert!(serde_json::from_value::<WebWorkspaceUpdateRequest>(json!({ "operation": "finish", "transaction": "test", "accepted": false, "folders": [] })).is_err());
}
