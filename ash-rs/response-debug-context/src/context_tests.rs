use super::*;

#[test]
fn extracts_only_selected_bounded_headers() {
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(br#"{"error":{"code":"token_expired","message":"secret body"}}"#);
    let context = ResponseDebugContext::from_headers([
        ("X-Request-ID", "request-1"),
        ("x-oai-request-id", "request-2"),
        ("cf-ray", "ray-1"),
        (
            "x-openai-authorization-error",
            "missing_authorization_header",
        ),
        ("x-error-json", encoded.as_str()),
        ("authorization", "Bearer secret"),
        ("set-cookie", "session=secret"),
    ]);
    assert_eq!(
        context,
        ResponseDebugContext {
            request_id: Some("request-1".into()),
            cf_ray: Some("ray-1".into()),
            auth_error: Some("missing_authorization_header".into()),
            auth_error_code: Some("token_expired".into()),
        }
    );
    assert!(!serde_json::to_string(&context).unwrap().contains("secret"));
}

#[test]
fn rejects_ambiguous_unbounded_and_malformed_evidence() {
    for headers in [
        vec![
            ("x-request-id", "a"),
            ("X-Request-ID", "b"),
            ("x-request-id", "c"),
        ],
        vec![("x-error-json", "not-base64"), ("cf-ray", "line\nbreak")],
        vec![("x-openai-authorization-error", "Bearer secret")],
    ] {
        assert_eq!(
            ResponseDebugContext::from_headers(headers),
            ResponseDebugContext::default()
        );
    }
    let oversized = "a".repeat(129);
    assert_eq!(
        ResponseDebugContext::from_headers([("x-request-id", oversized.as_str())]),
        ResponseDebugContext::default()
    );
    let oversized = "A".repeat(4097);
    assert_eq!(
        ResponseDebugContext::from_headers([("x-error-json", oversized.as_str())]),
        ResponseDebugContext::default()
    );
    assert_eq!(
        ResponseDebugContext::from_headers([("x-oai-request-id", "alternate")])
            .request_id
            .as_deref(),
        Some("alternate")
    );
}

#[test]
fn first_failure_and_unauthorized_survive_later_operations() {
    let mut diagnostic = ResponseDiagnostic::new(ResponseOperation::Model);
    for (status, request_id) in [
        (503, "busy"),
        (401, "rejected"),
        (401, "second"),
        (200, "success"),
    ] {
        diagnostic.record(RequestAttempt {
            auth_headers: vec![AuthHeader::Authorization],
            outcome: RequestOutcome::Http { status },
            response: ResponseDebugContext::from_headers([("x-request-id", request_id)]),
        });
    }
    assert_eq!(diagnostic.attempts, 4);
    assert_eq!(
        diagnostic
            .first_failure
            .unwrap()
            .response
            .request_id
            .as_deref(),
        Some("busy")
    );
    assert_eq!(
        diagnostic
            .first_unauthorized
            .unwrap()
            .response
            .request_id
            .as_deref(),
        Some("rejected")
    );
    assert_eq!(
        diagnostic.latest.unwrap().response.request_id.as_deref(),
        Some("success")
    );
}
