use crate::Error;
use crate::tests::FakeHttp;
use crate::tests::github;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_reads_the_account_endpoint_without_exposing_credentials() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!({"permissions":{"disableBypassPermissionsMode":"disable"}}),
    );
    let settings = github(http.clone()).managed_settings().await.unwrap();
    assert_eq!(
        settings,
        Some(json!({"permissions":{"disableBypassPermissionsMode":"disable"}}))
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://api.github.com/copilot_internal/managed_settings"
    );
    assert!(!format!("{:?}", requests[0]).contains("ash-test-token"));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_distinguishes_removal_permission_failure_and_invalid_data() {
    let http = Arc::new(FakeHttp::default());
    http.push(404, json!({}));
    http.push(403, json!({"message":"private"}));
    http.push(200, json!(["invalid"]));
    let client = github(http);
    assert_eq!(client.managed_settings().await.unwrap(), None);
    assert_eq!(
        client.managed_settings().await.unwrap_err(),
        Error::PermissionDenied
    );
    assert!(matches!(
        client.managed_settings().await.unwrap_err(),
        Error::InvalidResponse(_)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_compatibility_refusal_does_not_expose_or_require_error_metadata() {
    let http = Arc::new(FakeHttp::default());
    for body in [
        json!({"error_code":"client_update_required","client_id":"vscode","minimum_client_version":"private-version","message":"private-token"}),
        json!({"unexpected":"private-token"}),
        Value::Null,
    ] {
        http.push(466, body);
    }
    http.responses
        .lock()
        .unwrap()
        .push_back(Ok(ash_http_client::HttpResponse::new(
            466,
            vec![],
            b"not-json-private-token".to_vec(),
        )));
    http.push(200, json!({"model":"allowed-model"}));
    let client = github(http);
    for _ in 0..4 {
        let error = client.managed_settings().await.unwrap_err();
        assert_eq!(error, Error::ManagedSettingsUpdateRequired);
        assert!(!format!("{error:?}: {error}").contains("private"));
        let encoded = serde_json::to_value(&error).unwrap();
        assert_eq!(serde_json::from_value::<Error>(encoded).unwrap(), error);
    }
    assert_eq!(
        client.managed_settings().await.unwrap(),
        Some(json!({"model":"allowed-model"}))
    );
}
