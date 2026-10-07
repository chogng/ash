use std::net::Ipv4Addr;
use std::net::SocketAddr;

use super::AppServerListenInfo;
use super::AppServerListenInfoError;

#[test]
fn loopback_websocket_record_has_one_stable_json_shape() {
    let record =
        AppServerListenInfo::loopback_websocket(SocketAddr::from((Ipv4Addr::LOCALHOST, 43127)))
            .unwrap();

    assert_eq!(
        serde_json::to_value(record).unwrap(),
        serde_json::json!({
            "kind": "app-server-listen-info",
            "version": 1,
            "endpoint": "ws://127.0.0.1:43127"
        })
    );
}

#[test]
fn decoded_record_rejects_unknown_fields_and_unsafe_endpoints() {
    let unknown_field = serde_json::from_value::<AppServerListenInfo>(serde_json::json!({
        "kind": "app-server-listen-info",
        "version": 1,
        "endpoint": "ws://127.0.0.1:43127",
        "token": "must-not-appear"
    }));
    assert!(unknown_field.is_err());

    let non_loopback = serde_json::from_value::<AppServerListenInfo>(serde_json::json!({
        "kind": "app-server-listen-info",
        "version": 1,
        "endpoint": "ws://192.0.2.1:43127"
    }))
    .unwrap();
    assert_eq!(
        non_loopback.validate(),
        Err(AppServerListenInfoError::NonLoopbackEndpoint)
    );

    let wrong_version = serde_json::from_value::<AppServerListenInfo>(serde_json::json!({
        "kind": "app-server-listen-info",
        "version": 2,
        "endpoint": "ws://127.0.0.1:43127"
    }))
    .unwrap();
    assert_eq!(
        wrong_version.validate(),
        Err(AppServerListenInfoError::UnknownVersion)
    );
}
