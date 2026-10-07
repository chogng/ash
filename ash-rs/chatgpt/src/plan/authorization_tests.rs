use super::*;

#[test]
fn independent_registration_has_its_own_client_host_and_resource() {
    let grant = Grant::new("urn:uuid:ash-host", None).unwrap();
    let url = Url::parse(&grant.url).unwrap();
    let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], DYNAMIC_CLIENT);
    assert_eq!(query["ext_agent_host_id"], "urn:uuid:ash-host");
    assert_eq!(query["resource"], RESOURCE);
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(query["scope"].contains("chatgpt.tokens.use.direct"));
    assert_ne!(query["client_id"], crate::oauth::CLIENT_ID);
}

#[test]
fn returning_registration_uses_its_issued_client_and_workspace_identity() {
    let registration = Registration {
        client_id: "oaiapp_workspace".into(),
        subject: "user".into(),
        email: None,
        revision: 1,
        tokens: None,
    };
    let grant = Grant::new("urn:uuid:ash-host", Some(registration)).unwrap();
    let url = Url::parse(&grant.url).unwrap();
    let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "oaiapp_workspace");
    assert!(!query.contains_key("id_token_hint"));
    assert!(!query.contains_key("agent_name_hint"));
}

#[test]
fn token_response_requires_plan_grant_and_trusted_destination() {
    let mut response: TokenResponse = serde_json::from_value(serde_json::json!({
        "access_token":"access", "refresh_token":"refresh", "id_token":"id", "token_type":"Bearer", "expires_in":3600, "scope":"openid profile email"
    })).unwrap();
    assert!(response.into_tokens(None).is_err());
    assert!(trusted_auth_url("https://chatgpt.com/backend-api/codex").is_err());
    assert!(trusted_auth_url("https://evil.example/token").is_err());
}
