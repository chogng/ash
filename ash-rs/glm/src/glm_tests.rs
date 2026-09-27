use super::*;
use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use aes_gcm::aead::Aead;
use aes_gcm::aead::KeyInit;
use ash_client::ClientError;
use ash_client::ClientResponse;
use ash_login::AccountState;
use ash_login::LoginCompletion;
use ash_login::LoginEvents;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest;
use sha2::Sha256;
use std::collections::VecDeque;
use std::sync::mpsc;

struct ScriptedClient {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl ScriptedClient {
    fn new(bodies: Vec<String>) -> Self {
        Self {
            responses: Mutex::new(
                bodies
                    .into_iter()
                    .map(|body| ClientResponse::new(200, Vec::new(), body.into_bytes()))
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for ScriptedClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ClientError::Transport("script exhausted".into()))
    }
}

struct CompletionEvents(mpsc::Sender<LoginCompletion>);

impl LoginEvents for CompletionEvents {
    fn login_completed(&self, completion: LoginCompletion) {
        self.0.send(completion).unwrap();
    }

    fn account_updated(&self, _: AccountState) {}
}

fn init_response() -> String {
    serde_json::json!({
        "code": 0,
        "data": {
            "authorize_url": "https://zcode.z.ai/authorize",
            "expires_at": now_seconds() + 30,
            "flow_id": "flow/1",
            "poll_interval_sec": 1,
        }
    })
    .to_string()
}

fn client_for(provider: GlmProvider) -> Arc<ScriptedClient> {
    let mut ready = serde_json::json!({
        "code": 0,
        "data": {
            "status": "ready",
            "token": "zcode-jwt",
            "user": {"user_id":"user-1","email":"person@example.test","name":"Person"},
        }
    });
    ready["data"][provider.oauth_id()] = serde_json::json!({"access_token":"oauth-secret"});
    let mut bodies = vec![init_response(), ready.to_string()];
    if provider == GlmProvider::Zai {
        bodies.push(r#"{"code":200,"data":{"access_token":"biz-secret"}}"#.into());
    }
    bodies.extend([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目","projectId":"project"}]}]}}"#.into(),
        r#"{"code":200,"data":[]}"#.into(),
        r#"{"code":200,"data":{"apiKey":"key-id"}}"#.into(),
        r#"{"code":200,"data":{"secretKey":"secret"}}"#.into(),
    ]);
    Arc::new(ScriptedClient::new(bodies))
}

#[test]
fn account_login_acquires_private_coding_plan_credentials_for_each_region() {
    for provider in [GlmProvider::BigModel, GlmProvider::Zai] {
        let client = client_for(provider);
        let secrets = Arc::new(MemorySecretStore::default());
        let auth = GlmOAuth::with_client(provider, secrets.clone(), client.clone());
        let driver: Arc<dyn InteractiveLoginDriver> = auth.clone();
        let service = Arc::new(LoginService::new(driver).unwrap());
        auth.install_login_service(&service).unwrap();
        let (sender, receiver) = mpsc::channel();
        service
            .install_events(Arc::new(CompletionEvents(sender)))
            .unwrap();

        let started = service.begin(provider.login_method()).unwrap();
        assert!(
            matches!(started, BeginLogin::Browser { authorization_url, .. } if authorization_url == "https://zcode.z.ai/authorize")
        );
        let completion = receiver.recv_timeout(Duration::from_secs(4)).unwrap();
        assert!(matches!(
            completion.outcome,
            LoginCompletionOutcome::Succeeded { .. }
        ));
        let account = service.read().unwrap().accounts.pop().unwrap();
        assert_eq!(account.account.provider, provider.provider_id());
        assert_eq!(account.email.as_deref(), Some("person@example.test"));
        let target = auth.api_target().unwrap();
        assert_eq!(target.account_id, "user-1");
        assert_eq!(target.target.base_url, provider.model_url());
        assert!(
            target
                .target
                .headers
                .iter()
                .any(|header| header.name() == "Authorization"
                    && header.value() == "Bearer key-id.secret")
        );
        let saved = secrets.load(&provider.credential_key()).unwrap().unwrap();
        assert!(!String::from_utf8_lossy(saved.expose()).contains("oauth-secret"));
        let requests = client.requests.lock().unwrap();
        assert_eq!(
            requests[0].url(),
            "https://zcode.z.ai/api/v1/oauth/cli/init"
        );
        assert_eq!(
            requests[1].url(),
            "https://zcode.z.ai/api/v1/oauth/cli/poll/flow%2F1"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
            serde_json::json!({"provider":provider.oauth_id()})
        );
        drop(requests);
        service.logout_provider(provider.provider_id()).unwrap();
        assert!(auth.api_target().is_err());
    }
}

#[test]
fn cancelled_login_does_not_save_a_model_credential() {
    let provider = GlmProvider::BigModel;
    let client = Arc::new(ScriptedClient::new(vec![init_response()]));
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = GlmOAuth::with_client(provider, secrets.clone(), client);
    let service =
        Arc::new(LoginService::new(auth.clone() as Arc<dyn InteractiveLoginDriver>).unwrap());
    auth.install_login_service(&service).unwrap();
    let started = service.begin(provider.login_method()).unwrap();
    assert_eq!(
        service.cancel(started.login_id()).unwrap(),
        CancelLoginOutcome::Cancelled
    );
    assert!(secrets.load(&provider.credential_key()).unwrap().is_none());
}

#[test]
fn zcode_coding_plan_credentials_are_read_live_without_copying_them() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    let write_account = |identity: &str, key: &str| {
        let provider = "account:zai-individual-coding-plan";
        let entries = serde_json::json!({
            format!("account-provider:{provider}:identity"): encrypted(identity),
            format!("account-provider:coding-plan:{provider}:account:{identity}:api-key"): encrypted(key),
        });
        std::fs::write(&path, serde_json::to_vec(&entries).unwrap()).unwrap();
    };
    write_account("user-1", "key-1.secret");
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::Zai,
        secrets.clone(),
        Arc::new(ScriptedClient::new(Vec::new())),
        Some(zcode::ZCodeCredentials::at(path.clone())),
    );
    let account = auth.read_account().unwrap().unwrap();
    assert_eq!(account.account.account_id, "user-1");
    let first = auth.api_target().unwrap();
    assert_eq!(first.account_id, "user-1");
    assert_eq!(first.target.headers[0].value(), "Bearer key-1.secret");
    let service = LoginService::deferred(auth.clone() as Arc<dyn InteractiveLoginDriver>);
    assert!(matches!(
        service.begin(LoginMethod::ZaiBrowser).unwrap(),
        BeginLogin::Connected { .. }
    ));
    assert!(
        secrets
            .load(&GlmProvider::Zai.credential_key())
            .unwrap()
            .is_none()
    );
    assert!(auth.logout(&account.account).is_err());
    assert!(path.exists());

    write_account("user-2", "key-2.secret");
    let next = auth.api_target().unwrap();
    assert_eq!(next.account_id, "user-2");
    assert_eq!(next.target.headers[0].value(), "Bearer key-2.secret");
    assert_ne!(next.account_id, first.account_id);
    assert!(
        secrets
            .load(&GlmProvider::Zai.credential_key())
            .unwrap()
            .is_none()
    );
}

#[test]
fn zcode_account_without_coding_plan_key_allows_ash_login() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    std::fs::write(
        &path,
        r#"{"account-provider:account:zai-individual-coding-plan:identity":"user-1"}"#,
    )
    .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::Zai,
        Arc::new(MemorySecretStore::default()),
        Arc::new(ScriptedClient::new(vec![init_response()])),
        Some(zcode::ZCodeCredentials::at(path)),
    );
    assert!(auth.read_account().unwrap().is_none());
    assert!(auth.api_target().is_err());
    let service = LoginService::deferred(auth as Arc<dyn InteractiveLoginDriver>);
    let started = service.begin(LoginMethod::ZaiBrowser).unwrap();
    assert!(matches!(&started, BeginLogin::Browser { .. }));
}

#[test]
fn zcode_bigmodel_profile_without_coding_plan_key_is_disconnected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "oauth:bigmodel:user_info": encrypted(r#"{"id":"person-1","rawProfile":{"email":"person@example.test"}}"#),
        })
        .to_string(),
    )
    .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::BigModel,
        Arc::new(MemorySecretStore::default()),
        Arc::new(ScriptedClient::new(Vec::new())),
        Some(zcode::ZCodeCredentials::at(path)),
    );
    assert!(auth.read_account().unwrap().is_none());
}

#[test]
fn zcode_account_with_empty_coding_plan_key_allows_ash_login() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    let provider = "account:bigmodel-individual-coding-plan";
    std::fs::write(
        &path,
        serde_json::json!({
            format!("account-provider:{provider}:identity"): encrypted("person-1"),
            format!("account-provider:coding-plan:{provider}:account:person-1:api-key"): encrypted(" "),
        })
        .to_string(),
    )
    .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::BigModel,
        Arc::new(MemorySecretStore::default()),
        Arc::new(ScriptedClient::new(vec![init_response()])),
        Some(zcode::ZCodeCredentials::at(path)),
    );
    assert!(auth.read_account().unwrap().is_none());
    let service = LoginService::deferred(auth as Arc<dyn InteractiveLoginDriver>);
    assert!(matches!(
        service.begin(LoginMethod::BigModelBrowser).unwrap(),
        BeginLogin::Browser { .. }
    ));
}

#[test]
fn zcode_reuse_precedes_ash_login_until_zcode_is_unusable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    let provider = "account:bigmodel-individual-coding-plan";
    let write_zcode = |key: &str| {
        std::fs::write(&path, serde_json::json!({
            format!("account-provider:{provider}:identity"): encrypted("zcode-person"),
            format!("account-provider:coding-plan:{provider}:account:zcode-person:api-key"): key,
        }).to_string()).unwrap();
    };
    write_zcode("zcode-key.secret");
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &GlmProvider::BigModel.credential_key(),
            &SecretValue::new(
                serde_json::to_vec(&Credential {
                    account_id: "ash-person".into(),
                    email: None,
                    display_name: None,
                    model_key: "ash-key.secret".into(),
                    revision: 1,
                })
                .unwrap(),
            ),
        )
        .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::BigModel,
        secrets,
        Arc::new(ScriptedClient::new(Vec::new())),
        Some(zcode::ZCodeCredentials::at(path.clone())),
    );
    let external = auth.read_account().unwrap().unwrap();
    assert_eq!(external.account.account_id, "zcode-person");
    assert_eq!(
        auth.api_target().unwrap().target.headers[0].value(),
        "Bearer zcode-key.secret"
    );

    write_zcode("enc:v1:invalid");
    let account = auth.read_account().unwrap().unwrap();
    assert_eq!(account.account.account_id, "ash-person");
    let target = auth.api_target().unwrap();
    assert_eq!(target.account_id, "ash-person");
    assert_eq!(target.target.headers[0].value(), "Bearer ash-key.secret");
    auth.logout(&account.account).unwrap();
    assert!(auth.read_account().unwrap().is_none());
    assert!(path.exists());
}

#[test]
fn zcode_bigmodel_account_uses_its_own_request_key() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "oauth:bigmodel:user_info": encrypted(r#"{"id":"person/1","rawProfile":{"user_id":"person/1","email":"person@example.test","name":"Person"}}"#),
            "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:person%2F1:api-key": "bigmodel-key.secret"
        })
        .to_string(),
    )
    .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::BigModel,
        Arc::new(MemorySecretStore::default()),
        Arc::new(ScriptedClient::new(Vec::new())),
        Some(zcode::ZCodeCredentials::at(path)),
    );
    let target = auth.api_target().unwrap();
    assert_eq!(target.account_id, "person/1");
    assert_eq!(
        target.target.headers[0].value(),
        "Bearer bigmodel-key.secret"
    );
    assert_eq!(
        auth.read_account().unwrap().unwrap().email.as_deref(),
        Some("person@example.test")
    );
}

#[test]
fn zcode_zai_profile_identifies_the_matching_account_key() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "oauth:zai:user_info": encrypted(r#"{"user_id":"zai-user","email":"zai@example.test","name":"Zai User"}"#),
            "account-provider:coding-plan:account:zai-individual-coding-plan:account:zai-user:api-key": encrypted("zai-key.secret")
        })
        .to_string(),
    )
    .unwrap();
    let auth = GlmOAuth::with_client_and_zcode(
        GlmProvider::Zai,
        Arc::new(MemorySecretStore::default()),
        Arc::new(ScriptedClient::new(Vec::new())),
        Some(zcode::ZCodeCredentials::at(path)),
    );
    let account = auth.read_account().unwrap().unwrap();
    assert_eq!(account.account.account_id, "zai-user");
    assert_eq!(account.display_name.as_deref(), Some("Zai User"));
    assert_eq!(
        auth.api_target().unwrap().target.headers[0].value(),
        "Bearer zai-key.secret"
    );
}

fn encrypted(value: &str) -> String {
    let key = Sha256::digest(b"test-secret");
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let nonce = [7_u8; 12];
    let mut encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), value.as_bytes())
        .unwrap();
    let tag = encrypted.split_off(encrypted.len() - 16);
    format!(
        "enc:v1:{}.{}.{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(encrypted)
    )
}
