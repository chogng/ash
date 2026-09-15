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
        json!({ "port": 65536, "assets": null, "origin": null }),
        json!({ "port": 0, "assets": null, "origin": null, "profileRoot": "/another-profile" }),
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
