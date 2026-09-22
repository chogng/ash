use super::configured;

#[test]
fn trace_stream_is_explicit_and_validated_before_startup() {
    assert!(configured(None, None).unwrap().is_none());
    assert!(configured(Some("127.0.0.1:0".into()), None).is_err());
    assert!(configured(None, Some("secret".into())).is_err());
    let token = "ab".repeat(32);
    assert!(configured(Some("localhost:0".into()), Some(token.clone().into())).is_err());
    assert!(configured(Some("0.0.0.0:0".into()), Some(token.clone().into())).is_err());
    assert!(configured(Some("127.0.0.1:0".into()), Some("short".into())).is_err());
    let exporter = configured(Some("127.0.0.1:0".into()), Some(token.into()))
        .unwrap()
        .unwrap();
    assert!(exporter.local_addr().ip().is_loopback());
    assert_ne!(exporter.local_addr().port(), 0);
}
