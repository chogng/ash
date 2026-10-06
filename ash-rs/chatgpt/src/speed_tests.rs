use super::*;
use crate::ChatGptAuthManagement;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::sync::Mutex;

struct Client {
    bundle: Mutex<Value>,
    requests: Mutex<Vec<ClientRequest>>,
    during_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        Ok(ClientResponse::new(
            200,
            Vec::new(),
            serde_json::to_vec(&*self.bundle.lock().unwrap()).unwrap(),
        ))
    }
}

fn credentials(home: &Path, account: &str, plan: &str) {
    let jwt = |value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    std::fs::write(home.join("auth.json"), serde_json::to_vec(&json!({"auth_mode":"chatgpt","tokens":{
        "id_token":jwt(json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":account,"chatgpt_plan_type":plan}})),
        "access_token":jwt(json!({"exp":4_000_000_000_u64})),"refresh_token":"secret","account_id":account
    }})).unwrap()).unwrap();
}

fn auth(home: &Path, bundle: Value) -> (Arc<ChatGptOAuth>, Arc<Client>) {
    let client = Arc::new(Client {
        bundle: Mutex::new(bundle),
        requests: Mutex::new(Vec::new()),
        during_request: Mutex::new(None),
    });
    (
        ChatGptOAuth::with_client(
            home.into(),
            Arc::new(MemorySecretStore::default()),
            client.clone(),
            ChatGptAuthManagement::Codex,
        ),
        client,
    )
}

fn fragment(id: &str, contents: &str) -> Value {
    json!({"id":id,"name":id,"contents":contents})
}
fn bundle(fragments: Vec<Value>) -> Value {
    json!({"requirements_toml":{"enterprise_managed":fragments}})
}

#[test]
fn speed_access_distinguishes_pro_prices_and_requires_workspace_permission() {
    for (raw, grants, expected, queries) in [
        ("free", true, false, 0),
        ("go", true, false, 0),
        ("plus", true, false, 0),
        ("prolite", true, false, 0),
        ("pro", true, false, 0),
        ("promax", true, true, 1),
        ("promax", false, false, 1),
        ("business", true, false, 1),
        ("team", true, false, 1),
        ("enterprise", true, true, 1),
        ("enterprise", false, false, 1),
        ("enterprise_cbp_usage_based", true, true, 1),
        ("ent26", true, true, 1),
        ("edu", true, true, 1),
        ("education", true, true, 1),
        ("edu_pro", true, true, 1),
        ("unknown-future-plan", true, false, 0),
    ] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", raw);
        let original = std::fs::read(home.path().join("auth.json")).unwrap();
        let (auth, client) = auth(
            home.path(),
            bundle(vec![fragment(
                "permission",
                &format!("[features]\nultrafast_mode = {grants}"),
            )]),
        );
        auth.refresh_speed_access(&CancellationSource::new().token())
            .unwrap();
        assert_eq!(
            auth.speed_access().unwrap().ultrafast,
            Some(expected),
            "{raw}/{grants}"
        );
        assert_eq!(client.requests.lock().unwrap().len(), queries, "{raw}");
        assert_eq!(
            std::fs::read(home.path().join("auth.json")).unwrap(),
            original
        );
        if queries > 0 {
            let requests = client.requests.lock().unwrap();
            assert!(requests[0].url().ends_with("/api/codex/config/bundle"));
            assert!(requests[0].headers().iter().any(|header| {
                header.name().eq_ignore_ascii_case("ChatGPT-Account-ID")
                    && header.value() == "account-1"
            }));
        }
    }
}

#[test]
fn speed_access_has_no_implicit_enterprise_or_edu_grant() {
    for (plan, expected) in [("promax", true), ("enterprise", false), ("edu", false)] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", plan);
        let (auth, _) = auth(home.path(), json!({}));
        assert_eq!(auth.speed_access().unwrap().ultrafast, None);
        auth.refresh_speed_access(&CancellationSource::new().token())
            .unwrap();
        assert_eq!(auth.speed_access().unwrap().ultrafast, Some(expected));
    }
}

#[test]
fn speed_access_enforces_independent_policies_and_legacy_denials_with_precedence() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", "promax");
    let (auth, client) = auth(home.path(), json!({}));
    for fast in [false, true] {
        for ultrafast in [false, true] {
            *client.bundle.lock().unwrap() = bundle(vec![fragment(
                "current-policy",
                &format!("[features]\nfast_mode={fast}\nultrafast_mode={ultrafast}"),
            )]);
            auth.refresh_speed_access(&CancellationSource::new().token())
                .unwrap();
            assert_eq!(
                auth.speed_access().unwrap(),
                ChatGptSpeedAccess {
                    fast: Some(fast),
                    ultrafast: Some(ultrafast)
                }
            );
        }
    }
    *client.bundle.lock().unwrap() = bundle(vec![fragment(
        "rbac-fast-mode",
        "[features]\nfast_mode=false",
    )]);
    auth.refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(
        auth.speed_access().unwrap(),
        ChatGptSpeedAccess {
            fast: Some(false),
            ultrafast: Some(false)
        }
    );
    *client.bundle.lock().unwrap() = bundle(vec![
        fragment("enterprise-override", "[features]\nultrafast_mode=true"),
        fragment("rbac-fast-mode", "[features]\nfast_mode=false"),
    ]);
    auth.refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(
        auth.speed_access().unwrap(),
        ChatGptSpeedAccess {
            fast: Some(false),
            ultrafast: Some(true)
        }
    );
}

#[test]
fn speed_grants_are_revoked_on_plan_account_changes_expiry_and_remote_refresh() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", "promax");
    let (auth, client) = auth(home.path(), json!({}));
    auth.refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    let before = auth.model_catalog_identity().unwrap();
    credentials(home.path(), "account-1", "pro");
    assert_eq!(auth.speed_access().unwrap().ultrafast, Some(false));
    assert_ne!(auth.model_catalog_identity().unwrap(), before);
    credentials(home.path(), "account-2", "promax");
    assert_eq!(auth.speed_access().unwrap().ultrafast, None);
    credentials(home.path(), "account-1", "promax");
    auth.speed_access.lock().unwrap().as_mut().unwrap().observed =
        Instant::now() - ACCESS_FRESH_FOR;
    assert_eq!(auth.speed_access().unwrap().ultrafast, None);
    *client.bundle.lock().unwrap() = bundle(vec![fragment(
        "revoked",
        "[features]\nultrafast_mode=false",
    )]);
    auth.refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    assert_eq!(auth.speed_access().unwrap().ultrafast, Some(false));
}

#[test]
fn speed_discovery_rejects_plan_changes_during_the_request_and_invalid_policy_types() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", "promax");
    let (auth, client) = auth(home.path(), json!({}));
    let path = home.path().to_path_buf();
    *client.during_request.lock().unwrap() =
        Some(Box::new(move || credentials(&path, "account-1", "pro")));
    assert!(
        auth.refresh_speed_access(&CancellationSource::new().token())
            .is_err()
    );
    assert_eq!(auth.speed_access().unwrap().ultrafast, Some(false));
    credentials(home.path(), "account-1", "promax");
    for contents in [
        "[features]\nultrafast_mode='true'",
        "features='secret'",
        "invalid TOML '",
    ] {
        *client.bundle.lock().unwrap() = bundle(vec![fragment("invalid", contents)]);
        assert!(
            auth.refresh_speed_access(&CancellationSource::new().token())
                .is_err()
        );
        assert_eq!(auth.speed_access().unwrap().ultrafast, None);
    }
}
