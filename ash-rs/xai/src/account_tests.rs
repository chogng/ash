use super::*;
use crate::TokenCredential;
use crate::now_epoch_seconds;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginService;
use ash_secrets::MemorySecretStore;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

const PROFILE: &str = r#"{"userId":"user-a","email":"ada@example.test","firstName":"Ada","lastName":"Lovelace","organizationName":"Example","teamId":"team-a","subscriptionTier":"SuperGrokPro"}"#;
const TOKEN: &str =
    r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}"#;

struct Transport {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
    after_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Transport {
    fn new(responses: &[(u16, &str)]) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(
                responses
                    .iter()
                    .map(|(status, body)| {
                        ClientResponse::new(*status, vec![], body.as_bytes().to_vec())
                    })
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
            after_request: Mutex::new(None),
        })
    }
}

impl OperationClient for Transport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        let after = self.after_request.lock().unwrap().take();
        if let Some(after) = after {
            after();
        }
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected request"))
    }
}

fn credential() -> TokenCredential {
    TokenCredential {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        token_type: "Bearer".into(),
        scope: String::new(),
        expires_at: Some(now_epoch_seconds() + 3600),
        account_id: "login-a".into(),
        credential_revision: 1,
        profile: None,
    }
}

#[test]
fn subscription_load_updates_login_metadata_and_reads_all_business_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Transport::new(&[
        (200, PROFILE),
        (200, r#"{"allow_access":false,"on_demand_enabled":false}"#),
        (
            200,
            r#"{"config":{"creditUsagePercent":12.5,"prepaidBalance":{"val":"12345"}}}"#,
        ),
    ]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        transport.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential()).unwrap();
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    let data = auth
        .read_subscription("login-a", &CancellationSource::new().token())
        .unwrap();
    assert_eq!(data.settings.allow_access, Some(false));
    assert_eq!(data.billing.unwrap().credit_usage_percent, Some(12.5));
    let account = &service.read().unwrap().accounts[0];
    assert_eq!(account.email.as_deref(), Some("ada@example.test"));
    assert_eq!(account.display_name.as_deref(), Some("Ada Lovelace"));
    assert_eq!(account.plan.as_deref(), Some("SuperGrokPro"));
    assert_eq!(account.account.account_id, "login-a");
    let credential = auth.load_credential().unwrap().unwrap();
    assert_eq!(credential.access_token, "access");
    assert_eq!(credential.credential_revision, 1);
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url().to_owned())
            .collect::<Vec<_>>(),
        [
            "user?include=subscription",
            "settings",
            "billing?format=credits",
        ]
        .map(|path| format!("{}/{path}", crate::XAI_SUBSCRIPTION_API_BASE_URL))
    );
}

#[test]
fn profile_refresh_recovers_one_401_and_preserves_metadata_across_token_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Transport::new(&[(401, "private"), (200, TOKEN), (200, PROFILE), (200, TOKEN)]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        transport.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential()).unwrap();
    auth.refresh_account("login-a", &CancellationSource::new().token())
        .unwrap();
    let target = auth.api_target().unwrap();
    auth.recover_unauthorized(&target).unwrap().unwrap();
    let saved = auth.load_credential().unwrap().unwrap();
    assert_eq!(saved.refresh_token, "new-refresh");
    assert_eq!(saved.credential_revision, 3);
    assert_eq!(
        auth.read_account().unwrap().unwrap().email.as_deref(),
        Some("ada@example.test")
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 4);
}

#[test]
fn cancelled_or_wrong_account_requests_do_not_send_or_publish_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Transport::new(&[(200, PROFILE)]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        transport.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential()).unwrap();
    let cancel = CancellationSource::new();
    cancel.cancel();
    assert_eq!(
        auth.refresh_account("login-a", &cancel.token())
            .unwrap_err()
            .kind(),
        XaiErrorKind::Cancelled
    );
    assert_eq!(
        auth.refresh_account("login-b", &CancellationSource::new().token())
            .unwrap_err()
            .kind(),
        XaiErrorKind::AccountChanged
    );
    assert!(transport.requests.lock().unwrap().is_empty());
    let weak = Arc::downgrade(&auth);
    *transport.after_request.lock().unwrap() = Some(Box::new(move || {
        let mut next = credential();
        next.account_id = "login-b".into();
        weak.upgrade().unwrap().store_credential(&next).unwrap();
    }));
    assert_eq!(
        auth.refresh_account("login-a", &CancellationSource::new().token())
            .unwrap_err()
            .kind(),
        XaiErrorKind::AccountChanged
    );
    let saved = auth.load_credential().unwrap().unwrap();
    assert_eq!(saved.account_id, "login-b");
    assert!(saved.profile.is_none());
}

#[test]
fn a_changed_remote_identity_is_not_saved_and_status_failures_are_not_refreshed() {
    for (status, body, expected) in [
        (200, r#"{"userId":"other"}"#, XaiErrorKind::AccountChanged),
        (403, "secret", XaiErrorKind::Permission),
        (426, "secret", XaiErrorKind::UpgradeRequired),
        (429, "secret", XaiErrorKind::RateLimited),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let transport = Transport::new(&[(status, body)]);
        let auth = XaiOAuth::with_client(
            Arc::new(MemorySecretStore::default()),
            transport.clone(),
            dir.path().join("lock"),
        );
        let mut initial = credential();
        initial.profile = Some(serde_json::from_str(PROFILE).unwrap());
        auth.store_credential(&initial).unwrap();
        let error = auth
            .refresh_account("login-a", &CancellationSource::new().token())
            .unwrap_err();
        assert_eq!(error.kind(), expected);
        assert!(!error.to_string().contains("secret"));
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
        assert_eq!(
            auth.load_credential()
                .unwrap()
                .unwrap()
                .profile
                .as_ref()
                .unwrap()
                .user_id,
            "user-a"
        );
    }
}

#[test]
#[ignore = "Reads the existing Grok access token without refreshing or modifying Grok credentials"]
fn live_subscription_backend() {
    use ash_secrets::SecretStore;
    #[derive(serde::Deserialize)]
    struct GrokCredential {
        key: String,
        auth_mode: String,
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .expect("home directory");
    let path = std::path::PathBuf::from(home).join(".grok/auth.json");
    let before = zeroize::Zeroizing::new(std::fs::read(&path).expect("Grok login required"));
    let map: std::collections::BTreeMap<String, GrokCredential> =
        serde_json::from_slice(&before).expect("Grok auth map");
    let entry = map
        .get(&format!("https://auth.x.ai::{}", crate::CLIENT_ID))
        .expect("Grok OAuth login required");
    assert_eq!(entry.auth_mode, "oidc");
    let mut credential = credential();
    credential.access_token = entry.key.clone();
    credential.refresh_token.clear();
    credential.expires_at = None;
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &XaiOAuth::credential_key(),
            &ash_secrets::SecretValue::new(serde_json::to_vec(&credential).unwrap()),
        )
        .unwrap();
    let auth = XaiOAuth::production(secrets, dir.path().join("lock")).unwrap();
    let result = auth.read_subscription("login-a", &CancellationSource::new().token());
    let after = zeroize::Zeroizing::new(std::fs::read(&path).unwrap());
    assert!(*before == *after, "Grok auth changed during read-only test");
    let data =
        result.unwrap_or_else(|error| panic!("subscription query failed: {:?}", error.kind()));
    assert!(!data.account.user_id.is_empty());
    println!(
        "xAI account, settings and subscription usage queries passed; Grok credentials unchanged"
    );
}

#[test]
fn profile_commit_keeps_a_concurrently_rotated_token_and_discards_cancelled_results() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Transport::new(&[
        (200, PROFILE),
        (200, r#"{"userId":"user-a","email":"changed@example.test"}"#),
    ]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        transport.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential()).unwrap();
    let weak = Arc::downgrade(&auth);
    *transport.after_request.lock().unwrap() = Some(Box::new(move || {
        let mut rotated = credential();
        rotated.access_token = "rotated-access".into();
        rotated.refresh_token = "rotated-refresh".into();
        rotated.credential_revision = 2;
        weak.upgrade().unwrap().store_credential(&rotated).unwrap();
    }));
    auth.refresh_account("login-a", &CancellationSource::new().token())
        .unwrap();
    let saved = auth.load_credential().unwrap().unwrap();
    assert_eq!(saved.access_token, "rotated-access");
    assert_eq!(saved.refresh_token, "rotated-refresh");
    assert_eq!(saved.credential_revision, 2);
    let cancel = CancellationSource::new();
    let source = cancel.clone();
    *transport.after_request.lock().unwrap() = Some(Box::new(move || {
        source.cancel();
    }));
    assert_eq!(
        auth.refresh_account("login-a", &cancel.token())
            .unwrap_err()
            .kind(),
        XaiErrorKind::Cancelled
    );
    assert_eq!(
        auth.load_credential()
            .unwrap()
            .unwrap()
            .profile
            .as_ref()
            .unwrap()
            .email
            .as_deref(),
        Some("ada@example.test")
    );
}

#[test]
fn a_slower_profile_read_cannot_overwrite_a_newer_read() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Transport::new(&[
        (200, PROFILE),
        (
            200,
            r#"{"userId":"user-a","email":"old@example.test","teamId":"team-a"}"#,
        ),
    ]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        transport.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential()).unwrap();
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    let weak = Arc::downgrade(&auth);
    *transport.after_request.lock().unwrap() = Some(Box::new(move || {
        weak.upgrade()
            .unwrap()
            .refresh_account("login-a", &CancellationSource::new().token())
            .unwrap();
    }));
    assert_eq!(
        auth.refresh_account("login-a", &CancellationSource::new().token())
            .unwrap_err()
            .kind(),
        XaiErrorKind::AccountChanged
    );
    assert_eq!(
        auth.read_account().unwrap().unwrap().email.as_deref(),
        Some("ada@example.test")
    );
    assert_eq!(
        service.read().unwrap().accounts[0].email.as_deref(),
        Some("ada@example.test")
    );
}
