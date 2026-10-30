use super::*;

#[test]
fn private_headers_preserve_owner_account_routing_without_exporting_host_headers() {
    use ash_http_client::HttpHeader;

    let headers = credential_headers(vec![
        HttpHeader::new("Authorization", "Bearer private-token"),
        HttpHeader::new("ChatGPT-Account-ID", "private-account"),
        HttpHeader::new("X-OpenAI-Fedramp", "true"),
        HttpHeader::new("Originator", "ash"),
        HttpHeader::new("User-Agent", "Ash/test"),
    ]);
    assert_eq!(headers.len(), 3);
    assert_eq!(headers.get("X-OpenAI-Fedramp").unwrap(), "true");
    assert!(!headers.contains_key("Originator"));
    assert!(!headers.contains_key("User-Agent"));
}

#[test]
fn private_credential_frames_reject_rpc_and_unknown_fields_without_echoing_secrets() {
    for value in [
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"getAuthStatus","params":{"includeToken":true}}),
        serde_json::json!({"kind":"authorize","requestId":"aaaa","context":"context","accessToken":"private-value"}),
        serde_json::json!({"kind":"recover","requestId":12}),
    ] {
        assert!(serde_json::from_value::<HostCredentialRequest>(value).is_err());
    }
}

#[test]
fn renderer_method_registry_has_no_native_credential_entrypoint() {
    use ash_app_server_protocol::protocol::registry::CLIENT_METHODS;
    assert!(CLIENT_METHODS.iter().all(|definition| {
        !definition.method.contains("getAuthStatus")
            && !definition.method.contains("credential/authorize")
    }));
}
