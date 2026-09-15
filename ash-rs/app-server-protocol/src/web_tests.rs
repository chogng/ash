use super::*;
use serde_json::json;

#[test]
fn browser_session_metadata_has_no_daemon_authority() {
    let session = WebSessionInfo {
        token: "a".repeat(64),
        workspace_id: "workspace".into(),
        workspace_root: "/workspace".into(),
    };
    let value = serde_json::to_value(session).unwrap();
    assert_eq!(
        value,
        json!({ "token": "a".repeat(64), "workspaceId": "workspace", "workspaceRoot": "/workspace" })
    );
    let mut injected = value;
    injected["dirPermissionsHost"] = json!(true);
    assert!(serde_json::from_value::<WebSessionInfo>(injected).is_err());
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
