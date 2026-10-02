use super::*;

fn target() -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        "https://api.example.test/v1",
        vec![HttpHeader::new("X-Device-Proof", "private-proof")],
        RequestBinding::new(
            RequestPurpose::Model,
            RequestIdentity::account("example", "private-account", 7),
        ),
    )
}

#[test]
fn destination_binding_rejects_origin_changes_and_path_traversal() {
    let target = target();
    for destination in [
        "https://other.example.test/v1",
        "http://api.example.test/v1",
        "https://api.example.test:8443/v1",
        "https://user@api.example.test/v1",
    ] {
        assert!(
            target
                .request(HttpMethod::Get, destination, vec![], vec![])
                .is_err()
        );
    }
    for path in [
        "../other",
        "%2e%2e/other",
        "//other.example.test",
        "https://other.example.test",
        "other\\path",
        "other?token=secret",
    ] {
        assert!(target.endpoint(path).is_err());
    }
    assert_eq!(
        target.endpoint("messages").unwrap(),
        "https://api.example.test/v1/messages"
    );
    assert!(
        target
            .validate_destination("wss://api.example.test/v1/realtime?model=test")
            .is_ok()
    );
    assert!(
        target
            .validate_destination("ws://api.example.test/v1/realtime")
            .is_err()
    );
}

#[test]
fn protocol_headers_cannot_replace_domain_authentication() {
    let target = target();
    let error = target
        .request(
            HttpMethod::Post,
            target.endpoint("messages").unwrap(),
            vec![HttpHeader::new("x-device-proof", "replacement-secret")],
            vec![],
        )
        .unwrap_err();
    let detail = format!("{error:?}");
    assert!(detail.contains("conflicting API request header"));
    assert!(!detail.contains("replacement-secret"));
    assert!(!detail.contains("private-proof"));
    let request = target
        .request(
            HttpMethod::Post,
            target.endpoint("messages").unwrap(),
            vec![
                HttpHeader::new("x-device-proof", "private-proof"),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            vec![],
        )
        .unwrap();
    assert_eq!(request.headers().len(), 2);
}

#[test]
fn purpose_and_snapshot_identity_survive_protocol_header_additions() {
    let original = target();
    let extended = original
        .clone()
        .with_headers(vec![HttpHeader::new("X-Request-Id", "request")])
        .unwrap();
    assert_eq!(extended.binding(), original.binding());
    assert!(
        extended
            .require_purpose(RequestPurpose::InputTokenCount)
            .is_err()
    );
    assert!(extended.require_purpose(RequestPurpose::Account).is_err());
    let debug = format!("{extended:?}");
    assert!(!debug.contains("private-account"));
    assert!(!debug.contains("private-proof"));
}

#[test]
fn invalid_destination_secrets_do_not_enter_debug_output() {
    let target = ResolvedApiTarget::new(
        "https://private-user:private-password@api.example.test?key=private-key",
        vec![],
        RequestBinding::new(RequestPurpose::Model, RequestIdentity::Anonymous),
    );
    assert!(target.endpoint("messages").is_err());
    let debug = format!("{target:?}");
    for secret in ["private-user", "private-password", "private-key"] {
        assert!(!debug.contains(secret));
    }
}
