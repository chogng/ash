use super::StartupTrace;

fn trace(id: &str) -> StartupTrace {
    serde_json::from_value(serde_json::json!({
        "id": id, "carrierPid": 42, "scope": "connection"
    }))
    .unwrap()
}

#[test]
fn lineage_is_scoped_restored_and_not_inherited_by_threads() {
    let first = trace("11111111-1111-1111-1111-111111111111");
    let second = trace("22222222-2222-2222-2222-222222222222");
    assert!(StartupTrace::current().is_none());
    {
        let _owner = StartupTrace::enter(Some(first.clone()));
        assert_eq!(StartupTrace::current(), Some(first.clone()));
        {
            let _probe = StartupTrace::enter(Some(second.clone().probe()));
            let value = serde_json::to_value(StartupTrace::current()).unwrap();
            assert_eq!(value["id"], second.id);
            assert_eq!(value["scope"], "probe");
        }
        assert_eq!(StartupTrace::current(), Some(first.clone()));
        std::thread::spawn(move || {
            assert!(StartupTrace::current().is_none());
            let _worker = StartupTrace::enter(Some(second.clone()));
            assert_eq!(StartupTrace::current(), Some(second));
        })
        .join()
        .unwrap();
        assert_eq!(StartupTrace::current(), Some(first));
    }
    assert!(StartupTrace::current().is_none());
    assert!(StartupTrace::span("disabled").is_none());
}

#[test]
fn private_prelude_validates_lineage_without_changing_normal_connections() {
    let options = crate::ConnectionOptions::new(
        "/profile",
        None,
        crate::GrantSource::HostConfiguration,
        None,
    );
    let original =
        serde_json::to_value(crate::wire::ConnectionPrelude::from_options(&options)).unwrap();
    assert!(original.get("startupTrace").is_none());
    let identity = trace("11111111-1111-1111-1111-111111111111");
    let _owner = StartupTrace::enter(Some(identity.clone()));
    let value =
        serde_json::to_value(crate::wire::ConnectionPrelude::from_options(&options)).unwrap();
    let crate::wire::IncomingPrelude::Connection(decoded) =
        crate::wire::decode_prelude(format!("{value}\n").as_bytes()).unwrap()
    else {
        panic!("expected connection")
    };
    assert_eq!(decoded.startup_trace, Some(identity));
    for invalid in [
        serde_json::json!({"id":"bad\nidentity","carrierPid":42,"scope":"connection"}),
        serde_json::json!({"id":"11111111-1111-1111-1111-111111111111","carrierPid":0,"scope":"connection"}),
        serde_json::json!({"id":"11111111-1111-1111-1111-111111111111","carrierPid":42,"scope":"unknown"}),
    ] {
        let mut value = value.clone();
        value["startupTrace"] = invalid;
        assert!(crate::wire::decode_prelude(format!("{value}\n").as_bytes()).is_err());
    }
}
