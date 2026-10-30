use super::*;
use crate::ChatGptAuthManagement;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

#[derive(Default)]
struct Client {
    replies: Mutex<VecDeque<(u16, serde_json::Value)>>,
    calls: Mutex<usize>,
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        assert_eq!(request.url(), "https://auth.openai.com/oauth/token");
        *self.calls.lock().unwrap() += 1;
        let (status, value) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected OAuth refresh");
        Ok(ClientResponse::new(
            status,
            Vec::new(),
            serde_json::to_vec(&value).unwrap(),
        ))
    }
}

fn jwt(value: serde_json::Value) -> String {
    format!(
        "e30.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap())
    )
}

fn access(version: &str, expiry: u64) -> String {
    jwt(serde_json::json!({"jti":version,"exp":expiry}))
}

fn write(home: &Path, user: &str, token: &str) {
    let value = serde_json::json!({
        "auth_mode":"chatgpt", "last_refresh":chrono::Utc::now().to_rfc3339(),
        "tokens":{"id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":user,"chatgpt_account_id":"workspace-1"}})),
        "access_token":token,"refresh_token":"private-refresh","account_id":"workspace-1"}
    });
    std::fs::write(home.join("auth.json"), serde_json::to_vec(&value).unwrap()).unwrap();
}

fn session(home: &Path, client: Arc<Client>, mode: ChatGptAuthManagement) -> ChatGptWebAuthSession {
    let auth = ChatGptOAuth::with_client(
        home.into(),
        Arc::new(MemorySecretStore::default()),
        client,
        mode,
    );
    ChatGptWebAuthSession::new(auth).unwrap()
}

#[test]
fn native_consumer_uses_owner_refresh_before_the_first_request_and_recovers_only_once() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "user-1", &access("expired", 1));
    let client = Arc::new(Client::default());
    let initial = access("proactive", 4_000_000_000);
    let recovered = access("recovered", 4_000_000_000);
    client.replies.lock().unwrap().extend([
        (200, serde_json::json!({"access_token":initial})),
        (200, serde_json::json!({"access_token":recovered})),
    ]);
    let mut session = session(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    let context = session.context().to_owned();
    let headers = session.authorize("aaaa", &context).unwrap();
    assert!(
        headers
            .iter()
            .any(|header| header.value() == format!("Bearer {initial}"))
    );
    assert_eq!(*client.calls.lock().unwrap(), 1);
    let headers = session.recover("aaaa").unwrap().unwrap();
    assert!(
        headers
            .iter()
            .any(|header| header.value() == format!("Bearer {recovered}"))
    );
    assert!(session.recover("aaaa").unwrap().is_none());
    assert_eq!(*client.calls.lock().unwrap(), 2);
    assert!(
        !session.synchronize().unwrap(),
        "rotation must preserve the account context"
    );
}

#[test]
fn expired_cold_owner_refreshes_before_all_initial_grants_and_restart_reuses_the_commit() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "user-1", &access("expired", 1));
    let renewed = access("renewed-before-http", 4_000_000_000);
    let first = Arc::new(Client::default());
    first.replies.lock().unwrap().push_back((
        200,
        serde_json::json!({"access_token":renewed,"refresh_token":"rotated-private-refresh"}),
    ));
    {
        let mut cold = session(home.path(), first.clone(), ChatGptAuthManagement::Ash);
        let context = cold.context().to_owned();
        for id in ["aaaa", "bbbb", "cccc", "dddd"] {
            let headers = cold.authorize(id, &context).unwrap();
            assert!(
                headers
                    .iter()
                    .any(|header| header.name().eq_ignore_ascii_case("Authorization")
                        && header.value() == format!("Bearer {renewed}"))
            );
            cold.release(id);
        }
        assert_eq!(*first.calls.lock().unwrap(), 1);
    }
    // Recreate the authority itself, so no in-memory grant or token cache can
    // account for successful authorization after a full process restart.
    let next = Arc::new(Client::default());
    let mut restarted = session(home.path(), next.clone(), ChatGptAuthManagement::Ash);
    let headers = restarted
        .authorize("eeee", &restarted.context().to_owned())
        .unwrap();
    assert!(
        headers
            .iter()
            .any(|header| header.value() == format!("Bearer {renewed}"))
    );
    assert_eq!(*next.calls.lock().unwrap(), 0);
}

#[test]
fn expired_codex_cold_owner_exports_no_headers_until_its_external_owner_updates_the_login() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    write(home.path(), "user-1", &access("expired", 1));
    let original = std::fs::read(&path).unwrap();
    let client = Arc::new(Client::default());
    let mut cold = session(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    let context = cold.context().to_owned();
    assert!(matches!(
        cold.authorize("aaaa", &context),
        Err(ChatGptWebAuthError::Unavailable)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(*client.calls.lock().unwrap(), 0);
    let external = access("codex-owner-renewed", 4_000_000_000);
    write(home.path(), "user-1", &external);
    assert!(!cold.synchronize().unwrap());
    let headers = cold.authorize("bbbb", &context).unwrap();
    assert!(
        headers
            .iter()
            .any(|header| header.value() == format!("Bearer {external}"))
    );
    assert_eq!(*client.calls.lock().unwrap(), 0);
}

#[test]
fn failed_expired_cold_refresh_never_exports_the_old_token_or_overwrites_storage() {
    for permanent in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("auth.json");
        write(home.path(), "user-1", &access("expired", 1));
        let original = std::fs::read(&path).unwrap();
        let client = Arc::new(Client::default());
        client.replies.lock().unwrap().push_back(if permanent {
            (400, serde_json::json!({"error":"invalid_grant"}))
        } else {
            (503, serde_json::json!({"error":"temporary"}))
        });
        let mut cold = session(home.path(), client.clone(), ChatGptAuthManagement::Ash);
        let context = cold.context().to_owned();
        assert!(matches!(
            cold.authorize("aaaa", &context),
            Err(ChatGptWebAuthError::Unavailable)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        if permanent {
            assert!(matches!(
                cold.authorize("bbbb", &context),
                Err(ChatGptWebAuthError::Unavailable)
            ));
            assert_eq!(*client.calls.lock().unwrap(), 1);
        } else {
            let renewed = access("recovered-after-transient-failure", 4_000_000_000);
            client
                .replies
                .lock()
                .unwrap()
                .push_back((200, serde_json::json!({"access_token":renewed})));
            let headers = cold.authorize("bbbb", &context).unwrap();
            assert!(
                headers
                    .iter()
                    .any(|header| header.value() == format!("Bearer {renewed}"))
            );
            assert_eq!(*client.calls.lock().unwrap(), 2);
        }
    }
}

#[test]
fn codex_owned_credentials_are_reloaded_without_a_competing_refresh() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "user-1", &access("old", 4_000_000_000));
    let client = Arc::new(Client::default());
    let mut session = session(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    let context = session.context().to_owned();
    session.authorize("aaaa", &context).unwrap();
    assert!(session.recover("aaaa").unwrap().is_none());
    session.release("aaaa");
    session.authorize("bbbb", &context).unwrap();
    let rotated = access("external-rotation", 4_000_000_000);
    write(home.path(), "user-1", &rotated);
    assert!(!session.synchronize().unwrap());
    let headers = session.recover("bbbb").unwrap().unwrap();
    assert!(
        headers
            .iter()
            .any(|header| header.value() == format!("Bearer {rotated}"))
    );
    assert_eq!(*client.calls.lock().unwrap(), 0);
}

#[test]
fn switching_users_in_the_same_workspace_revokes_old_requests_and_rejects_stale_contexts() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "user-1", &access("one", 4_000_000_000));
    let mut session = session(
        home.path(),
        Arc::new(Client::default()),
        ChatGptAuthManagement::Codex,
    );
    let old = session.context().to_owned();
    session.authorize("aaaa", &old).unwrap();
    write(home.path(), "user-2", &access("two", 4_000_000_000));
    assert!(session.synchronize().unwrap());
    assert_ne!(session.context(), old);
    assert!(matches!(
        session.recover("aaaa"),
        Err(ChatGptWebAuthError::AccountChanged)
    ));
    assert!(matches!(
        session.authorize("bbbb", &old),
        Err(ChatGptWebAuthError::AccountChanged)
    ));
    session
        .authorize("bbbb", &session.context().to_owned())
        .unwrap();
    std::fs::remove_file(home.path().join("auth.json")).unwrap();
    assert!(session.synchronize().unwrap());
    assert!(matches!(
        session.recover("bbbb"),
        Err(ChatGptWebAuthError::AccountChanged)
    ));
}

#[test]
fn native_consumer_obeys_the_auth_owners_storage_policy() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "user-1", &access("one", 4_000_000_000));
    std::fs::write(
        home.path().join("config.toml"),
        "cli_auth_credentials_store = 'ephemeral'\n",
    )
    .unwrap();
    let mut session = session(
        home.path(),
        Arc::new(Client::default()),
        ChatGptAuthManagement::Codex,
    );
    assert!(matches!(
        session.authorize("aaaa", &session.context().to_owned()),
        Err(ChatGptWebAuthError::Unavailable)
    ));
}

fn web_owner(
    profile: &Path,
    home: &Path,
    secrets: Arc<dyn SecretStore>,
    client: Arc<dyn OperationClient>,
) -> Arc<ChatGptWebAuthentication> {
    let codex = ChatGptOAuth::with_client(
        home.into(),
        secrets.clone(),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    ChatGptWebAuthentication::new(profile.into(), secrets, client, codex)
}

fn seed_private(secrets: &dyn SecretStore, token: &str) {
    let value = serde_json::json!({
        "_ash_source":"ash", "_ash_generation":1,
        "auth_mode":"chatgpt", "last_refresh":chrono::Utc::now().to_rfc3339(),
        "tokens":{"id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"private-user","chatgpt_account_id":"private-workspace"}})),
        "access_token":token,"refresh_token":"private-independent-refresh","account_id":"private-workspace"}
    });
    secrets
        .store(
            &ash_secrets::SecretKey::new("provider/chatgpt-web/credentials-v1").unwrap(),
            &ash_secrets::SecretValue::new(serde_json::to_vec(&value).unwrap()),
        )
        .unwrap();
}

fn assert_token(headers: &[HttpHeader], token: &str) {
    assert!(
        headers
            .iter()
            .any(|header| header.name().eq_ignore_ascii_case("authorization")
                && header.value() == format!("Bearer {token}"))
    );
}

#[test]
fn independent_web_expired_cold_owner_refreshes_once_and_reopened_store_reuses_commit() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    let original = std::fs::read(home.path().join("auth.json")).unwrap();
    let storage = profile.path().join("secrets");
    let secrets = Arc::new(ash_secrets::FileSecretStore::open(&storage).unwrap());
    seed_private(secrets.as_ref(), &access("expired", 1));
    let client = Arc::new(Client::default());
    let renewed = access("independent-renewed", 4_000_000_000);
    client.replies.lock().unwrap().push_back((
        200,
        serde_json::json!({"access_token":renewed,"refresh_token":"rotated-independent-refresh"}),
    ));
    {
        let owner = web_owner(profile.path(), home.path(), secrets.clone(), client.clone());
        let mut session = owner.session().unwrap();
        let context = session.context().to_owned();
        for id in ["aaaa", "bbbb", "cccc", "dddd"] {
            assert_token(&session.authorize(id, &context).unwrap(), &renewed);
        }
        assert_eq!(*client.calls.lock().unwrap(), 1);
    }
    drop(secrets);
    let reopened = Arc::new(ash_secrets::FileSecretStore::open(storage).unwrap());
    let next = Arc::new(Client::default());
    let owner = web_owner(profile.path(), home.path(), reopened, next.clone());
    let mut session = owner.session().unwrap();
    assert_token(
        &session
            .authorize("eeee", &session.context().to_owned())
            .unwrap(),
        &renewed,
    );
    assert_eq!(*next.calls.lock().unwrap(), 0);
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        original
    );
    assert!(!profile.path().join("chatgpt-web/auth.json").exists());
}

#[test]
fn independent_web_401_recovery_is_bounded_and_source_switch_retires_old_grants() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let external = access("external", 4_000_000_000);
    write(home.path(), "external-user", &external);
    let original = std::fs::read(home.path().join("auth.json")).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let initial = access("initial", 4_000_000_000);
    seed_private(secrets.as_ref(), &initial);
    let client = Arc::new(Client::default());
    let renewed = access("401-renewed", 4_000_000_000);
    client
        .replies
        .lock()
        .unwrap()
        .push_back((200, serde_json::json!({"access_token":renewed})));
    let owner = web_owner(profile.path(), home.path(), secrets, client.clone());
    let driver = owner.login_driver();
    let mut session = owner.session().unwrap();
    let context = session.context().to_owned();
    assert_token(&session.authorize("aaaa", &context).unwrap(), &initial);
    assert_token(&session.recover("aaaa").unwrap().unwrap(), &renewed);
    assert!(session.recover("aaaa").unwrap().is_none());
    assert_eq!(*client.calls.lock().unwrap(), 1);
    driver
        .begin(BeginLoginRequest {
            login_id: LoginId::new("source").unwrap(),
            method: LoginMethod::ChatGptWebCodex,
        })
        .unwrap();
    assert!(session.synchronize().unwrap());
    assert!(session.authorize("bbbb", &context).is_err());
    assert_token(
        &session
            .authorize("cccc", &session.context().to_owned())
            .unwrap(),
        &external,
    );
    driver
        .logout(&driver.read_account().unwrap().unwrap().account)
        .unwrap();
    assert!(driver.read_account().unwrap().is_none());
    assert!(owner.managed.auth.load().unwrap().is_none());
    assert!(session.synchronize().unwrap());
    assert!(
        session
            .authorize("dddd", &session.context().to_owned())
            .is_err()
    );
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        original
    );
}

#[test]
fn independent_web_refresh_failures_never_fall_back_to_codex() {
    for permanent in [true, false] {
        let profile = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            "external-user",
            &access("external", 4_000_000_000),
        );
        let secrets = Arc::new(MemorySecretStore::default());
        seed_private(secrets.as_ref(), &access("expired", 1));
        let client = Arc::new(Client::default());
        client.replies.lock().unwrap().push_back(if permanent {
            (400, serde_json::json!({"error":"invalid_grant"}))
        } else {
            (503, serde_json::json!({"error":"temporary"}))
        });
        let owner = web_owner(profile.path(), home.path(), secrets.clone(), client.clone());
        let mut session = owner.session().unwrap();
        assert!(
            session
                .authorize("aaaa", &session.context().to_owned())
                .is_err()
        );
        assert_eq!(
            owner.managed.auth.web_source().unwrap().0,
            WebCredentialSource::Ash
        );
        if permanent {
            assert!(
                session
                    .authorize("bbbb", &session.context().to_owned())
                    .is_err()
            );
            assert_eq!(*client.calls.lock().unwrap(), 1);
        } else {
            let renewed = access("after-transient", 4_000_000_000);
            client
                .replies
                .lock()
                .unwrap()
                .push_back((200, serde_json::json!({"access_token":renewed})));
            assert_token(
                &session
                    .authorize("bbbb", &session.context().to_owned())
                    .unwrap(),
                &renewed,
            );
        }
    }
}

#[test]
fn independent_web_secret_failure_fails_closed_even_with_valid_codex() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    let secrets = Arc::new(ash_secrets::UnavailableSecretStore);
    let owner = web_owner(
        profile.path(),
        home.path(),
        secrets,
        Arc::new(Client::default()),
    );
    let mut session = owner.session().unwrap();
    assert!(
        session
            .authorize("aaaa", &session.context().to_owned())
            .is_err()
    );
    assert!(owner.login_driver().read_account().is_err());
}

#[derive(Default)]
struct Completions {
    values: Mutex<Vec<ash_login::LoginCompletion>>,
    ready: std::sync::Condvar,
}
impl ash_login::LoginEvents for Completions {
    fn login_completed(&self, completion: ash_login::LoginCompletion) {
        self.values.lock().unwrap().push(completion);
        self.ready.notify_all();
    }
    fn account_updated(&self, _: ash_login::AccountState) {}
}
impl Completions {
    fn wait(&self) -> ash_login::LoginCompletion {
        let (values, timeout) = self
            .ready
            .wait_timeout_while(
                self.values.lock().unwrap(),
                std::time::Duration::from_secs(5),
                |values| values.is_empty(),
            )
            .unwrap();
        assert!(
            !timeout.timed_out(),
            "login completion was not routed to its origin"
        );
        values.last().unwrap().clone()
    }
}

#[derive(Default)]
struct DeviceClient {
    gate: (Mutex<bool>, std::sync::Condvar),
}
impl OperationClient for DeviceClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        let value = match request.url() {
            "https://auth.openai.com/api/accounts/deviceauth/usercode" => {
                serde_json::json!({"device_auth_id":"test-device","user_code":"TEST-CODE","interval":1})
            }
            "https://auth.openai.com/api/accounts/deviceauth/token" => {
                let (lock, ready) = &self.gate;
                let (_guard, timeout) = ready
                    .wait_timeout_while(
                        lock.lock().unwrap(),
                        std::time::Duration::from_secs(5),
                        |open| !*open,
                    )
                    .unwrap();
                assert!(!timeout.timed_out(), "test did not release the device flow");
                serde_json::json!({"authorization_code":"code","code_verifier":"verifier"})
            }
            "https://auth.openai.com/oauth/token" => {
                serde_json::json!({"id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"private-user","chatgpt_account_id":"private-workspace"}})), "access_token":access("device-flow",4_000_000_000),"refresh_token":"independent-device-refresh"})
            }
            other => panic!("unexpected request {other}"),
        };
        Ok(ClientResponse::new(
            200,
            vec![],
            serde_json::to_vec(&value).unwrap(),
        ))
    }
}
impl DeviceClient {
    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}

fn login_service(owner: &Arc<ChatGptWebAuthentication>) -> (Arc<LoginService>, Arc<Completions>) {
    let driver = owner.login_driver();
    let service = Arc::new(LoginService::new(driver.clone()).unwrap());
    driver.install_login_service(&service).unwrap();
    let events = Arc::new(Completions::default());
    service.install_events(events.clone()).unwrap();
    (service, events)
}

#[test]
fn independent_device_login_routes_completion_to_its_original_window_and_ignores_other_windows_cancel()
 {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(DeviceClient::default());
    let owner = web_owner(profile.path(), home.path(), secrets, client.clone());
    let (first, events) = login_service(&owner);
    let started = first.begin(LoginMethod::ChatGptWebDeviceCode).unwrap();
    let (second, second_events) = login_service(&owner);
    assert_eq!(
        second
            .begin(LoginMethod::ChatGptWebDeviceCode)
            .unwrap_err()
            .kind(),
        LoginErrorKind::Conflict
    );
    assert_eq!(
        second.cancel(started.login_id()).unwrap(),
        CancelLoginOutcome::NotFound
    );
    client.release();
    let completed = events.wait();
    assert_eq!(&completed.login_id, started.login_id());
    assert!(matches!(
        completed.outcome,
        ash_login::LoginCompletionOutcome::Succeeded { .. }
    ));
    assert!(second_events.values.lock().unwrap().is_empty());
    assert_eq!(
        first.read().unwrap().accounts[0].account.provider,
        "chatgpt-web"
    );
    assert_eq!(
        second.refresh().unwrap().accounts[0].account.provider,
        "chatgpt-web"
    );
    assert!(!home.path().join("auth.json").exists());
    let mut session = owner.session().unwrap();
    assert_token(
        &session
            .authorize("aaaa", &session.context().to_owned())
            .unwrap(),
        &access("device-flow", 4_000_000_000),
    );
}

#[test]
fn switching_to_codex_cancels_pending_private_login_and_fences_its_late_commit() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    let client = Arc::new(DeviceClient::default());
    let owner = web_owner(
        profile.path(),
        home.path(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
    );
    let (first, events) = login_service(&owner);
    let started = first.begin(LoginMethod::ChatGptWebDeviceCode).unwrap();
    let (second, _) = login_service(&owner);
    second.begin(LoginMethod::ChatGptWebCodex).unwrap();
    let completion = events.wait();
    assert_eq!(&completion.login_id, started.login_id());
    assert!(matches!(
        completion.outcome,
        ash_login::LoginCompletionOutcome::Failed { .. }
    ));
    client.release();
    // The storage revision also protects against callbacks in another process,
    // independently of this owner's cancelled worker registry.
    assert!(owner.managed.auth.load().unwrap().is_none());
    assert_eq!(
        owner.managed.auth.web_source().unwrap().0,
        WebCredentialSource::Codex
    );
    assert_eq!(
        second.read().unwrap().accounts[0].account.provider,
        "chatgpt-web"
    );
}

#[test]
fn independent_login_commit_is_rejected_after_another_owner_changes_source() {
    let profile = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let first = crate::storage::CodexAuthStore::managed(profile.path().into(), secrets.clone());
    let second = crate::storage::CodexAuthStore::managed(profile.path().into(), secrets);
    first.select_web_source(WebCredentialSource::Ash).unwrap();
    let write = first.managed_login_write().unwrap();
    second
        .select_web_source(WebCredentialSource::Codex)
        .unwrap();
    second.select_web_source(WebCredentialSource::Ash).unwrap();
    let tokens = crate::credential::TokenResponse {
        id_token: jwt(
            serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"private-user","chatgpt_account_id":"private-workspace"}}),
        ),
        access_token: access("late", 4_000_000_000),
        refresh_token: "private-refresh".into(),
    };
    assert!(first.write_login(&tokens, write).is_err());
    assert!(first.load().unwrap().is_none());
}

#[test]
fn provider_logout_retires_an_empty_external_source_and_pending_login() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(DeviceClient::default());
    let owner = web_owner(profile.path(), home.path(), secrets.clone(), client.clone());
    let (service, events) = login_service(&owner);
    // No current account must not make Sign Out a no-op: a later Codex login
    // cannot silently opt this profile back into external reuse.
    service.logout_provider("chatgpt-web").unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    assert!(owner.login_driver().read_account().unwrap().is_none());
    let started = service.begin(LoginMethod::ChatGptWebDeviceCode).unwrap();
    service.logout_provider("chatgpt-web").unwrap();
    assert_eq!(&events.wait().login_id, started.login_id());
    client.release();
    assert!(owner.managed.auth.load().unwrap().is_none());
    let restarted = web_owner(
        profile.path(),
        home.path(),
        secrets,
        Arc::new(Client::default()),
    );
    assert!(restarted.login_driver().read_account().unwrap().is_none());
}

#[test]
fn independent_refresh_commit_failure_never_grants_an_unpersisted_token() {
    struct Storage {
        values: MemorySecretStore,
        fail: std::sync::atomic::AtomicBool,
    }
    impl SecretStore for Storage {
        fn load(
            &self,
            key: &ash_secrets::SecretKey,
        ) -> Result<Option<ash_secrets::SecretValue>, ash_secrets::SecretStoreError> {
            self.values.load(key)
        }
        fn store(
            &self,
            key: &ash_secrets::SecretKey,
            value: &ash_secrets::SecretValue,
        ) -> Result<(), ash_secrets::SecretStoreError> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err(ash_secrets::SecretStoreError::new(
                    ash_secrets::SecretStoreErrorKind::BackendUnavailable,
                    "fixture persistence failure",
                ))
            } else {
                self.values.store(key, value)
            }
        }
        fn delete(
            &self,
            key: &ash_secrets::SecretKey,
        ) -> Result<ash_secrets::DeleteSecretOutcome, ash_secrets::SecretStoreError> {
            self.values.delete(key)
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Storage {
        values: MemorySecretStore::default(),
        fail: false.into(),
    });
    seed_private(secrets.as_ref(), &access("expired", 1));
    secrets
        .fail
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let client = Arc::new(Client::default());
    client.replies.lock().unwrap().push_back((
        200,
        serde_json::json!({"access_token":access("uncommitted",4_000_000_000)}),
    ));
    let owner = web_owner(profile.path(), home.path(), secrets, client.clone());
    let mut session = owner.session().unwrap();
    assert!(
        session
            .authorize("aaaa", &session.context().to_owned())
            .is_err()
    );
    assert_eq!(
        owner.managed.auth.load().unwrap().unwrap().access_token,
        access("expired", 1)
    );
    assert_eq!(*client.calls.lock().unwrap(), 1);
}

#[test]
fn web_and_model_subscription_disconnect_states_do_not_control_each_other() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(Client::default());
    let model = ChatGptOAuth::with_client(
        home.path().into(),
        secrets.clone(),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let owner =
        ChatGptWebAuthentication::new(profile.path().into(), secrets, client, model.clone());
    let driver = owner.login_driver();
    let model_account = model.read_account().unwrap().unwrap().account;
    model.logout(&model_account).unwrap();
    assert!(model.read_account().unwrap().is_none());
    assert!(driver.read_account().unwrap().is_some());
    driver
        .begin(BeginLoginRequest {
            login_id: LoginId::new("external-source").unwrap(),
            method: LoginMethod::ChatGptWebCodex,
        })
        .unwrap();
    driver.logout_provider(&[]).unwrap();
    model
        .begin(BeginLoginRequest {
            login_id: LoginId::new("model-reconnect").unwrap(),
            method: LoginMethod::OpenAiChatGptDeviceCode,
        })
        .unwrap();
    assert!(model.read_account().unwrap().is_some());
    assert!(driver.read_account().unwrap().is_none());
}

#[test]
fn malformed_private_source_metadata_never_selects_valid_external_credentials() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "external-user",
        &access("external", 4_000_000_000),
    );
    for value in [
        serde_json::json!({"tokens":null}),
        serde_json::json!({"_ash_source":"codex"}),
        serde_json::json!({"_ash_source":"unknown","_ash_generation":1}),
        serde_json::json!({"_ash_source":"ash","_ash_generation":-1}),
    ] {
        let secrets = Arc::new(MemorySecretStore::default());
        secrets
            .store(
                &ash_secrets::SecretKey::new("provider/chatgpt-web/credentials-v1").unwrap(),
                &ash_secrets::SecretValue::new(serde_json::to_vec(&value).unwrap()),
            )
            .unwrap();
        let owner = web_owner(
            profile.path(),
            home.path(),
            secrets,
            Arc::new(Client::default()),
        );
        let mut session = owner.session().unwrap();
        assert!(
            session
                .authorize("aaaa", &session.context().to_owned())
                .is_err()
        );
        assert!(owner.login_driver().read_account().is_err());
    }
}
