use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_login::AccountMultiplicity;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::AccountStatus;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::CompleteLogin;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginCompletionOutcome;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginFailure;
use ash_login::LoginId;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use url::Url;
use url::form_urlencoded;
use zeroize::Zeroize;

pub const GITHUB_PROVIDER_ID: &str = "github";

const USER_URL: &str = "https://api.github.com/user";
const CREDENTIAL_KEY: &str = "provider/github/current/oauth";
const ACCOUNTS_KEY: &str = "provider/github/accounts";
const REFRESH_MARGIN: u64 = 300;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(100);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

/// Identifies the exact grant captured by a repository operation, without credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubAuthorization {
    pub host: String,
    pub account_id: String,
    pub grant_id: String,
}

/// Supplies credentials only while the captured authorization remains current.
pub trait GitHubCredentialProvider: Send + Sync {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError>;
    fn token(&self, authorization: &GitHubAuthorization) -> Result<SecretValue, LoginError>;

    /// Selects an exact account, without changing another window's default account.
    fn authorization_for(&self, account_id: &str) -> Result<GitHubAuthorization, LoginError> {
        let grant = self.authorization()?;
        if grant.account_id != account_id {
            return Err(error(
                LoginErrorKind::ExternalLoginRequired,
                "GitHub account is not connected",
            ));
        }
        Ok(grant)
    }
}

/// Redacted GitHub account metadata; host is part of the credential authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubAccount {
    pub id: String,
    pub host: String,
    pub login: String,
    pub status: AccountStatus,
    pub credential_revision: u64,
}

/// Manages the provider-owned catalog and connects host-bound user tokens.
pub trait GitHubAccountManager: Send + Sync {
    /// The primary grant is first; remaining accounts have stable identity order.
    fn accounts(&self) -> Result<Vec<GitHubAccount>, LoginError>;
    fn connect_token(
        &self,
        host: &str,
        token: SecretValue,
        cancellation: &CancellationToken,
    ) -> Result<GitHubAccount, LoginError>;
}

struct BrowserAuthorization {
    client_id: String,
    authorize_url: Url,
    token_url: Url,
}

/// Owns GitHub accounts; browser authorization additionally requires the product token broker.
pub struct GitHubOAuth {
    browser: Option<BrowserAuthorization>,
    http: Arc<dyn HttpClient>,
    secrets: Arc<dyn SecretStore>,
    self_weak: Weak<Self>,
    login_service: Mutex<Weak<LoginService>>,
    active: Mutex<BTreeMap<LoginId, Arc<AtomicBool>>>,
    credential_lock: Mutex<()>,
}

impl GitHubOAuth {
    pub fn new(
        client_id: String,
        broker_base_url: Url,
        http: Arc<dyn HttpClient>,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Arc<Self>, LoginError> {
        if client_id.is_empty() || !client_id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err(error(
                LoginErrorKind::InvalidInput,
                "GitHub client ID is invalid",
            ));
        }
        if broker_base_url.scheme() != "https"
            || broker_base_url.cannot_be_a_base()
            || broker_base_url.host_str().is_none()
            || !broker_base_url.username().is_empty()
            || broker_base_url.password().is_some()
            || broker_base_url.query().is_some()
            || broker_base_url.fragment().is_some()
            || !broker_base_url.path().ends_with('/')
        {
            return Err(error(
                LoginErrorKind::InvalidInput,
                "GitHub broker URL is invalid",
            ));
        }
        let authorize_url = broker_base_url
            .join("v1/oauth/github/authorize")
            .map_err(|_| error(LoginErrorKind::InvalidInput, "GitHub broker URL is invalid"))?;
        let token_url = broker_base_url
            .join("v1/oauth/github/token")
            .map_err(|_| error(LoginErrorKind::InvalidInput, "GitHub broker URL is invalid"))?;
        Ok(Self::with_browser(
            Some(BrowserAuthorization {
                client_id,
                authorize_url,
                token_url,
            }),
            http,
            secrets,
        ))
    }

    /// Token connections work independently of the product's browser authorization configuration.
    pub fn tokens(http: Arc<dyn HttpClient>, secrets: Arc<dyn SecretStore>) -> Arc<Self> {
        Self::with_browser(None, http, secrets)
    }

    fn with_browser(
        browser: Option<BrowserAuthorization>,
        http: Arc<dyn HttpClient>,
        secrets: Arc<dyn SecretStore>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            browser,
            http,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            credential_lock: Mutex::new(()),
        })
    }

    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    fn credential_key() -> SecretKey {
        SecretKey::new(CREDENTIAL_KEY).expect("static GitHub credential key")
    }

    fn accounts_key() -> SecretKey {
        SecretKey::new(ACCOUNTS_KEY).expect("static GitHub accounts key")
    }

    fn load_credentials(&self) -> Result<Credentials, LoginError> {
        let stored = self.secrets.load(&Self::accounts_key()).map_err(|_| {
            error(
                LoginErrorKind::Unavailable,
                "GitHub credential store is unavailable",
            )
        })?;
        if let Some(stored) = stored {
            return serde_json::from_slice(stored.expose())
                .map_err(|_| error(LoginErrorKind::Driver, "Stored GitHub accounts are invalid"));
        }
        // One-way migration keeps existing cloud logins while retiring the single-account key.
        let legacy = self.secrets.load(&Self::credential_key()).map_err(|_| {
            error(
                LoginErrorKind::Unavailable,
                "GitHub credential store is unavailable",
            )
        })?;
        let mut catalog = Credentials::default();
        if let Some(legacy) = legacy {
            let credential: Credential = serde_json::from_slice(legacy.expose()).map_err(|_| {
                error(
                    LoginErrorKind::Driver,
                    "Stored GitHub credential is invalid",
                )
            })?;
            let id = credential.identity();
            catalog.default_account = Some(id.clone());
            catalog.accounts.insert(id, credential);
            self.save_credentials(&catalog)?;
            self.secrets.delete(&Self::credential_key()).map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub credential migration failed",
                )
            })?;
        }
        Ok(catalog)
    }

    fn save_credentials(&self, catalog: &Credentials) -> Result<(), LoginError> {
        let bytes = serde_json::to_vec(catalog).map_err(|_| {
            error(
                LoginErrorKind::Driver,
                "GitHub credentials could not be encoded",
            )
        })?;
        self.secrets
            .store(&Self::accounts_key(), &SecretValue::new(bytes))
            .map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub credential store is unavailable",
                )
            })
    }

    fn store_credential(&self, credential: &Credential) -> Result<(), LoginError> {
        let mut catalog = self.load_credentials()?;
        let id = credential.identity();
        let mut credential = credential.clone();
        // Logout removes the revision counter. A fresh grant identity prevents
        // reconnecting with the same token from reviving an earlier operation.
        credential.grant_nonce = random_base64url()?;
        if let Some(previous) = catalog.accounts.get(&id) {
            credential.credential_revision = previous.credential_revision.saturating_add(1);
        }
        // Cloud-only consumers use the cloud grant; connecting Enterprise does not replace it.
        if credential.host == "github.com" || catalog.default_account.is_none() {
            catalog.default_account = Some(id.clone());
        }
        catalog.accounts.insert(id, credential);
        self.save_credentials(&catalog)
    }

    fn current_credential(&self) -> Result<Option<Credential>, LoginError> {
        self.credential_for(None)
    }

    fn credential_for(&self, selection: Option<&str>) -> Result<Option<Credential>, LoginError> {
        let _lock = self.credential_lock.lock().map_err(lock_error)?;
        let mut catalog = self.load_credentials()?;
        let Some(id) = selection
            .map(str::to_owned)
            .or_else(|| catalog.default_account.clone())
        else {
            return Ok(None);
        };
        let Some(mut credential) = catalog.accounts.remove(&id) else {
            return Ok(None);
        };
        if !credential.client_id.is_empty()
            && self
                .browser
                .as_ref()
                .is_some_and(|browser| credential.client_id != browser.client_id)
        {
            return Ok(None);
        }
        if credential.needs_refresh() && credential.can_refresh() && self.browser.is_some() {
            match self.refresh_token(&credential) {
                Ok(token) => {
                    let user = self.user(&token.access_token)?;
                    if user.id.to_string() != credential.account_id {
                        return Err(error(
                            LoginErrorKind::Driver,
                            "GitHub account changed during token refresh",
                        ));
                    }
                    credential.replace_token(token);
                    catalog.accounts.insert(id, credential.clone());
                    self.save_credentials(&catalog)?;
                    if let Some(service) = self.login_service.lock().map_err(lock_error)?.upgrade()
                    {
                        service.update_account(credential.snapshot())?;
                    }
                }
                Err(failure) if failure.kind() == LoginErrorKind::ExternalLoginRequired => {}
                Err(failure) => return Err(failure),
            }
        }
        Ok(Some(credential))
    }

    fn authorize(&self) -> Result<BrowserGrant, LoginError> {
        let browser = self.browser.as_ref().ok_or_else(|| {
            error(
                LoginErrorKind::Unavailable,
                "GitHub browser authorization is not configured",
            )
        })?;
        let state = random_base64url()?;
        let verifier = random_base64url()?;
        let path = format!("/github-oauth/{}", random_base64url()?);
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub callback cannot listen"))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub callback cannot listen"))?;
        let port = listener
            .local_addr()
            .map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub callback address is unavailable",
                )
            })?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}{path}");
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorization_url = browser.authorize_url.clone();
        authorization_url
            .query_pairs_mut()
            .append_pair("client_id", &browser.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(BrowserGrant {
            listener,
            redirect_uri,
            path,
            state,
            verifier,
            authorization_url: authorization_url.into(),
        })
    }

    fn await_authorization(
        &self,
        grant: BrowserGrant,
        cancelled: &AtomicBool,
    ) -> Result<Credential, LoginError> {
        let browser = self.browser.as_ref().ok_or_else(|| {
            error(
                LoginErrorKind::Unavailable,
                "GitHub browser authorization is not configured",
            )
        })?;
        let deadline = Instant::now() + LOGIN_TIMEOUT;
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(error(
                    LoginErrorKind::Driver,
                    "GitHub authorization was cancelled",
                ));
            }
            if Instant::now() >= deadline {
                return Err(error(
                    LoginErrorKind::Driver,
                    "GitHub authorization expired",
                ));
            }
            match grant.listener.accept() {
                Ok((mut stream, _)) => {
                    let Some(code) = read_callback(&mut stream, &grant.path, &grant.state)? else {
                        continue;
                    };
                    if cancelled.load(Ordering::Acquire) {
                        return Err(error(
                            LoginErrorKind::Driver,
                            "GitHub authorization was cancelled",
                        ));
                    }
                    let response = self.post_form(
                        browser.token_url.as_str(),
                        &[
                            ("client_id", &browser.client_id),
                            ("grant_type", "authorization_code"),
                            ("code", &code),
                            ("redirect_uri", &grant.redirect_uri),
                            ("code_verifier", &grant.verifier),
                        ],
                    )?;
                    let token: TokenResponse =
                        serde_json::from_slice(response.body()).map_err(|_| {
                            error(
                                LoginErrorKind::Driver,
                                "GitHub returned an invalid token response",
                            )
                        })?;
                    let token = token.into_token()?;
                    let user = self.user(&token.access_token)?;
                    return Ok(Credential::new(token, user, browser.client_id.clone()));
                }
                Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(CANCELLATION_POLL_INTERVAL);
                }
                Err(_) => return Err(error(LoginErrorKind::Unavailable, "GitHub callback failed")),
            }
        }
    }

    fn refresh_token(&self, credential: &Credential) -> Result<Token, LoginError> {
        let browser = self.browser.as_ref().ok_or_else(|| {
            error(
                LoginErrorKind::Unavailable,
                "GitHub browser authorization is not configured",
            )
        })?;
        let response = self.post_form(
            browser.token_url.as_str(),
            &[
                ("client_id", &browser.client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", &credential.refresh_token),
            ],
        )?;
        let token: TokenResponse = serde_json::from_slice(response.body()).map_err(|_| {
            error(
                LoginErrorKind::Driver,
                "GitHub returned an invalid token refresh",
            )
        })?;
        if token.error.is_some() {
            return Err(error(
                LoginErrorKind::ExternalLoginRequired,
                "GitHub sign-in has expired",
            ));
        }
        token.into_token()
    }

    fn user(&self, access_token: &str) -> Result<GitHubUser, LoginError> {
        let request = HttpRequest::new(
            HttpMethod::Get,
            USER_URL,
            vec![
                HttpHeader::new("Accept", "application/vnd.github+json"),
                HttpHeader::new("Authorization", format!("Bearer {access_token}")),
                HttpHeader::new("X-GitHub-Api-Version", "2022-11-28"),
                HttpHeader::new("User-Agent", "Ash Desktop"),
            ],
            Vec::new(),
        )
        .map_err(|_| {
            error(
                LoginErrorKind::Driver,
                "GitHub user request could not be constructed",
            )
        })?
        .without_redirects();
        let response = self
            .http
            .execute(&request)
            .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub is unavailable"))?;
        if !response.is_success() {
            return Err(error(
                LoginErrorKind::Driver,
                "GitHub rejected the account token",
            ));
        }
        let user: GitHubUser = serde_json::from_slice(response.body())
            .map_err(|_| error(LoginErrorKind::Driver, "GitHub returned an invalid account"))?;
        if user.id == 0 || user.login.is_empty() {
            return Err(error(
                LoginErrorKind::Driver,
                "GitHub returned an incomplete account",
            ));
        }
        Ok(user)
    }

    fn post_form(
        &self,
        url: &str,
        fields: &[(&str, &str)],
    ) -> Result<ash_http_client::HttpResponse, LoginError> {
        let body = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish()
            .into_bytes();
        let request = HttpRequest::post(
            url,
            vec![
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Content-Type", "application/x-www-form-urlencoded"),
                HttpHeader::new("User-Agent", "Ash Desktop"),
            ],
            body,
        )
        .map_err(|_| {
            error(
                LoginErrorKind::Driver,
                "GitHub OAuth request could not be constructed",
            )
        })?;
        let response = self
            .http
            .execute(&request)
            .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub is unavailable"))?;
        if !response.is_success() {
            return Err(error(LoginErrorKind::Driver, "GitHub OAuth request failed"));
        }
        Ok(response)
    }

    fn finish_login(&self, login_id: LoginId, result: Result<Credential, LoginError>) {
        let mut active = self.active.lock().expect("GitHub login state lock");
        let Some(cancelled) = active.get(&login_id) else {
            return;
        };
        if cancelled.load(Ordering::Acquire) {
            active.remove(&login_id);
            return;
        }
        let outcome = match result.and_then(|credential| {
            let _lock = self.credential_lock.lock().map_err(lock_error)?;
            self.store_credential(&credential)?;
            let stored = self
                .load_credentials()?
                .accounts
                .remove(&credential.identity())
                .expect("stored GitHub account");
            Ok(stored.snapshot())
        }) {
            Ok(account) => LoginCompletionOutcome::Succeeded { account },
            Err(failure) => LoginCompletionOutcome::Failed {
                failure: LoginFailure {
                    code: "github_login_failed".into(),
                    message: failure.to_string(),
                },
            },
        };
        active.remove(&login_id);
        drop(active);
        if let Some(service) = self
            .login_service
            .lock()
            .expect("GitHub login service lock")
            .upgrade()
        {
            let _ = service.complete(CompleteLogin { login_id, outcome });
        }
    }
}

impl InteractiveLoginDriver for GitHubOAuth {
    fn provider_id(&self) -> &'static str {
        GITHUB_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self
            .current_credential()?
            .map(|credential| credential.snapshot()))
    }

    fn account_multiplicity(&self) -> AccountMultiplicity {
        AccountMultiplicity::Multiple
    }

    fn read_accounts(&self) -> Result<Vec<AccountSnapshot>, LoginError> {
        let ids: Vec<_> = {
            let _lock = self.credential_lock.lock().map_err(lock_error)?;
            self.load_credentials()?.accounts.into_keys().collect()
        };
        ids.iter()
            .filter_map(|id| self.credential_for(Some(id)).transpose())
            .map(|result| result.map(|credential| credential.snapshot()))
            .collect()
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        if request.method != LoginMethod::GitHubBrowser {
            return Err(error(
                LoginErrorKind::InvalidInput,
                "GitHub supports browser authorization",
            ));
        }
        let mut active = self.active.lock().map_err(lock_error)?;
        if !active.is_empty() {
            return Err(error(
                LoginErrorKind::Conflict,
                "a GitHub login is already active",
            ));
        }
        let grant = self.authorize()?;
        let authorization_url = grant.authorization_url.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(request.login_id.clone(), Arc::clone(&cancelled));
        let weak = self.self_weak.clone();
        let login_id = request.login_id.clone();
        thread::spawn(move || {
            if let Some(runtime) = weak.upgrade() {
                let result = runtime.await_authorization(grant, &cancelled);
                runtime.finish_login(login_id, result);
            }
        });
        Ok(BeginLogin::Browser {
            login_id: request.login_id,
            authorization_url,
        })
    }

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let Some(cancelled) = self.active.lock().map_err(lock_error)?.remove(login_id) else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        cancelled.store(true, Ordering::Release);
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        if account.provider != GITHUB_PROVIDER_ID {
            return Err(error(
                LoginErrorKind::InvalidInput,
                "account is not owned by GitHub",
            ));
        }
        let mut active = self.active.lock().map_err(lock_error)?;
        for cancelled in active.values() {
            cancelled.store(true, Ordering::Release);
        }
        active.clear();
        let _lock = self.credential_lock.lock().map_err(lock_error)?;
        let mut catalog = self.load_credentials()?;
        catalog.accounts.remove(&account.account_id);
        if catalog.default_account.as_deref() == Some(&account.account_id) {
            catalog.default_account = catalog
                .accounts
                .iter()
                .find(|(_, credential)| credential.host == "github.com")
                .or_else(|| catalog.accounts.iter().next())
                .map(|(id, _)| id.clone());
        }
        self.save_credentials(&catalog)
    }
}

impl GitHubCredentialProvider for GitHubOAuth {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError> {
        self.current_credential()?
            .filter(Credential::is_ready)
            .map(|credential| credential.authorization())
            .ok_or_else(|| {
                error(
                    LoginErrorKind::ExternalLoginRequired,
                    "GitHub authentication is required",
                )
            })
    }

    fn authorization_for(&self, account_id: &str) -> Result<GitHubAuthorization, LoginError> {
        self.credential_for(Some(account_id))?
            .filter(Credential::is_ready)
            .map(|credential| credential.authorization())
            .ok_or_else(|| {
                error(
                    LoginErrorKind::ExternalLoginRequired,
                    "GitHub authentication is required",
                )
            })
    }

    fn token(&self, authorization: &GitHubAuthorization) -> Result<SecretValue, LoginError> {
        let credential = self
            .credential_for(Some(&authorization.account_id))?
            .filter(Credential::is_ready)
            .filter(|credential| credential.authorization() == *authorization)
            .ok_or_else(|| {
                error(
                    LoginErrorKind::ExternalLoginRequired,
                    "GitHub authorization changed or expired",
                )
            })?;
        Ok(SecretValue::new(
            credential.access_token.as_bytes().to_vec(),
        ))
    }
}

impl GitHubAccountManager for GitHubOAuth {
    fn accounts(&self) -> Result<Vec<GitHubAccount>, LoginError> {
        let ids: Vec<_> = {
            let _lock = self.credential_lock.lock().map_err(lock_error)?;
            let catalog = self.load_credentials()?;
            // Consumers without an account picker use the primary grant. Keep the
            // public catalog in that same order so its displayed sender is accurate.
            let mut ids: Vec<_> = catalog.accounts.into_keys().collect();
            if let Some(index) = ids
                .iter()
                .position(|id| Some(id) == catalog.default_account.as_ref())
            {
                let primary = ids.remove(index);
                ids.insert(0, primary);
            }
            ids
        };
        ids.iter()
            .filter_map(|id| self.credential_for(Some(id)).transpose())
            .map(|result| result.map(|credential| credential.account()))
            .collect()
    }

    fn connect_token(
        &self,
        host: &str,
        token: SecretValue,
        cancellation: &CancellationToken,
    ) -> Result<GitHubAccount, LoginError> {
        let host = host.trim().to_ascii_lowercase();
        crate::Repository::new(host.clone(), "account".into(), "identity".into())
            .map_err(|_| error(LoginErrorKind::InvalidInput, "GitHub host is invalid"))?;
        let access_token = std::str::from_utf8(token.expose())
            .map_err(|_| error(LoginErrorKind::InvalidInput, "GitHub token is invalid"))?;
        if access_token.is_empty()
            || access_token.len() > 4096
            || access_token
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(error(
                LoginErrorKind::InvalidInput,
                "GitHub token is invalid",
            ));
        }
        let url = if host == "github.com" {
            USER_URL.to_owned()
        } else {
            format!("https://{host}/api/v3/user")
        };
        let request = HttpRequest::new(
            HttpMethod::Get,
            url,
            vec![
                HttpHeader::new("Accept", "application/vnd.github+json"),
                HttpHeader::new("User-Agent", "Ash Desktop"),
                HttpHeader::new("Authorization", format!("Bearer {access_token}")),
            ],
            Vec::new(),
        )
        .map_err(|_| error(LoginErrorKind::InvalidInput, "GitHub token is invalid"))?
        .without_redirects();
        let response = self
            .http
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub is unavailable"))?;
        if !response.is_success() {
            return Err(error(
                LoginErrorKind::ExternalLoginRequired,
                "GitHub rejected the account token",
            ));
        }
        let user: GitHubUser = serde_json::from_slice(response.body())
            .map_err(|_| error(LoginErrorKind::Driver, "GitHub returned an invalid account"))?;
        if user.id == 0 || user.login.is_empty() {
            return Err(error(
                LoginErrorKind::Driver,
                "GitHub returned an incomplete account",
            ));
        }
        cancellation
            .check()
            .map_err(|_| error(LoginErrorKind::Driver, "GitHub connection was cancelled"))?;
        let mut credential = Credential::new(
            Token {
                access_token: access_token.to_owned(),
                refresh_token: String::new(),
                expires_at: None,
                refresh_expires_at: None,
            },
            user,
            String::new(),
        );
        credential.host = host;
        {
            let _lock = self.credential_lock.lock().map_err(lock_error)?;
            self.store_credential(&credential)?;
        }
        let credential = self
            .credential_for(Some(&credential.identity()))?
            .ok_or_else(|| error(LoginErrorKind::Driver, "GitHub account was removed"))?;
        if let Some(service) = self.login_service.lock().map_err(lock_error)?.upgrade() {
            service.update_account(credential.snapshot())?;
        }
        Ok(credential.account())
    }
}

struct BrowserGrant {
    listener: TcpListener,
    redirect_uri: String,
    path: String,
    state: String,
    verifier: String,
    authorization_url: String,
}

impl Drop for BrowserGrant {
    fn drop(&mut self) {
        self.verifier.zeroize();
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    error: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token_expires_in: Option<u64>,
    token_type: Option<String>,
}

impl TokenResponse {
    fn into_token(mut self) -> Result<Token, LoginError> {
        if !self
            .token_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("bearer"))
        {
            return Err(error(
                LoginErrorKind::Driver,
                "GitHub returned an invalid token type",
            ));
        }
        let access_token = self
            .access_token
            .take()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                error(
                    LoginErrorKind::Driver,
                    "GitHub returned an empty access token",
                )
            })?;
        let refresh_token = self.refresh_token.take().unwrap_or_default();
        if self.expires_in.is_some() && refresh_token.is_empty() {
            return Err(error(
                LoginErrorKind::Driver,
                "GitHub omitted the refresh token",
            ));
        }
        Ok(Token {
            access_token,
            refresh_token,
            expires_at: self.expires_in.map(|seconds| now().saturating_add(seconds)),
            refresh_expires_at: self
                .refresh_token_expires_in
                .map(|seconds| now().saturating_add(seconds)),
        })
    }
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

struct Token {
    access_token: String,
    refresh_token: String,
    expires_at: Option<u64>,
    refresh_expires_at: Option<u64>,
}

#[derive(Default, Deserialize, Serialize)]
struct Credentials {
    default_account: Option<String>,
    accounts: BTreeMap<String, Credential>,
}

fn cloud_host() -> String {
    "github.com".into()
}

#[derive(Clone, Deserialize, Serialize)]
struct Credential {
    #[serde(default = "cloud_host")]
    host: String,
    #[serde(default)]
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: Option<u64>,
    refresh_expires_at: Option<u64>,
    account_id: String,
    login: String,
    credential_revision: u64,
    #[serde(default)]
    grant_nonce: String,
}

impl Credential {
    fn identity(&self) -> String {
        if self.host == "github.com" {
            self.account_id.clone()
        } else {
            format!("{}/{}", self.host, self.account_id)
        }
    }
    fn account(&self) -> GitHubAccount {
        let snapshot = self.snapshot();
        GitHubAccount {
            id: self.identity(),
            host: self.host.clone(),
            login: self.login.clone(),
            status: snapshot.status,
            credential_revision: self.credential_revision,
        }
    }

    fn authorization(&self) -> GitHubAuthorization {
        // A re-login or token replacement must never inherit private cache entries from an older grant.
        let mut digest = Sha256::new();
        digest.update(self.access_token.as_bytes());
        digest.update(self.credential_revision.to_le_bytes());
        digest.update(self.grant_nonce.as_bytes());
        let grant_id = URL_SAFE_NO_PAD.encode(digest.finalize());
        GitHubAuthorization {
            host: self.host.clone(),
            account_id: self.identity(),
            grant_id,
        }
    }

    fn new(token: Token, user: GitHubUser, client_id: String) -> Self {
        Self {
            host: cloud_host(),
            client_id,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_at,
            refresh_expires_at: token.refresh_expires_at,
            account_id: user.id.to_string(),
            login: user.login,
            credential_revision: 1,
            grant_nonce: String::new(),
        }
    }

    fn needs_refresh(&self) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at <= now().saturating_add(REFRESH_MARGIN))
    }

    fn can_refresh(&self) -> bool {
        !self.refresh_token.is_empty()
            && self
                .refresh_expires_at
                .is_none_or(|expires_at| expires_at > now())
    }

    fn is_ready(&self) -> bool {
        !self.access_token.is_empty() && !self.needs_refresh()
    }

    fn replace_token(&mut self, token: Token) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.access_token = token.access_token;
        self.refresh_token = token.refresh_token;
        self.expires_at = token.expires_at;
        self.refresh_expires_at = token.refresh_expires_at;
        self.credential_revision += 1;
    }

    fn snapshot(&self) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: GITHUB_PROVIDER_ID.into(),
                account_id: self.identity(),
            },
            email: None,
            display_name: Some(self.login.clone()),
            organization: None,
            plan: None,
            status: if self.is_ready() {
                AccountStatus::Ready
            } else {
                AccountStatus::ReauthenticationRequired
            },
            credential_revision: self.credential_revision,
        }
    }
}

impl Drop for Credential {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize)]
struct GitHubUser {
    id: u64,
    login: String,
}

fn random_base64url() -> Result<String, LoginError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        error(
            LoginErrorKind::Unavailable,
            "GitHub authorization randomness is unavailable",
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn read_callback(
    stream: &mut TcpStream,
    path: &str,
    state: &str,
) -> Result<Option<String>, LoginError> {
    // Accepted sockets can inherit the listener's nonblocking mode on macOS.
    // The callback reader owns a bounded blocking read, unlike the accept loop.
    stream
        .set_nonblocking(false)
        .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub callback failed"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| error(LoginErrorKind::Unavailable, "GitHub callback failed"))?;
    let mut buffer = [0_u8; 8192];
    let mut length = 0;
    while length < buffer.len() {
        let received = stream
            .read(&mut buffer[length..])
            .map_err(|_| error(LoginErrorKind::Driver, "GitHub callback failed"))?;
        if received == 0 {
            break;
        }
        length += received;
        if buffer[..length]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = std::str::from_utf8(&buffer[..length])
        .map_err(|_| error(LoginErrorKind::Driver, "GitHub callback failed"))?;
    let Some(target) = request
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.split_once(' ').map(|(target, _)| target))
    else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return Ok(None);
    };
    if !target.starts_with('/') || target.starts_with("//") {
        return Ok(None);
    }
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Ok(None);
    };
    if url.path() != path {
        return Ok(None);
    }
    let values = url.query_pairs().collect::<Vec<_>>();
    let matching_state = values
        .iter()
        .filter(|(key, _)| key == "state")
        .collect::<Vec<_>>();
    let codes = values
        .iter()
        .filter(|(key, _)| key == "code")
        .collect::<Vec<_>>();
    let denied = values.iter().any(|(key, _)| key == "error");
    if matching_state.len() != 1 || matching_state[0].1 != state || codes.len() > 1 {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return Ok(None);
    }
    if denied {
        let body = b"Authorization declined. You may close this window.";
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(headers.as_bytes());
        let _ = stream.write_all(body);
        return Err(error(
            LoginErrorKind::Driver,
            "GitHub authorization was declined",
        ));
    }
    let Some(code) = codes
        .first()
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let body = b"Authorization received. You may return to Ash.";
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
    Ok(Some(code))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock precedes Unix epoch")
        .as_secs()
}

fn error(kind: LoginErrorKind, message: &'static str) -> LoginError {
    LoginError::new(kind, message)
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    error(
        LoginErrorKind::Unavailable,
        "GitHub login state is unavailable",
    )
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
