use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
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
const REFRESH_MARGIN: u64 = 300;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(100);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

/// Owns Ash's GitHub account session and browser authorization through Ash's token broker.
pub struct GitHubOAuth {
    client_id: String,
    authorize_url: Url,
    token_url: Url,
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
        Ok(Arc::new_cyclic(|self_weak| Self {
            client_id,
            authorize_url,
            token_url,
            http,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            credential_lock: Mutex::new(()),
        }))
    }

    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    fn credential_key() -> SecretKey {
        SecretKey::new(CREDENTIAL_KEY).expect("static GitHub credential key")
    }

    fn load_credential(&self) -> Result<Option<Credential>, LoginError> {
        self.secrets
            .load(&Self::credential_key())
            .map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub credential store is unavailable",
                )
            })?
            .map(|value| {
                serde_json::from_slice(value.expose()).map_err(|_| {
                    error(
                        LoginErrorKind::Driver,
                        "Stored GitHub credential is invalid",
                    )
                })
            })
            .transpose()
    }

    fn store_credential(&self, credential: &Credential) -> Result<(), LoginError> {
        let bytes = serde_json::to_vec(credential).map_err(|_| {
            error(
                LoginErrorKind::Driver,
                "GitHub credential could not be encoded",
            )
        })?;
        self.secrets
            .store(&Self::credential_key(), &SecretValue::new(bytes))
            .map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub credential store is unavailable",
                )
            })
    }

    fn current_credential(&self) -> Result<Option<Credential>, LoginError> {
        let _lock = self.credential_lock.lock().map_err(lock_error)?;
        let Some(mut credential) = self.load_credential()? else {
            return Ok(None);
        };
        if credential.client_id != self.client_id {
            return Ok(None);
        }
        if credential.needs_refresh() && credential.can_refresh() {
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
                    self.store_credential(&credential)?;
                }
                Err(failure) if failure.kind() == LoginErrorKind::ExternalLoginRequired => {}
                Err(failure) => return Err(failure),
            }
        }
        Ok(Some(credential))
    }

    fn authorize(&self) -> Result<BrowserGrant, LoginError> {
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
        let mut authorization_url = self.authorize_url.clone();
        authorization_url
            .query_pairs_mut()
            .append_pair("client_id", &self.client_id)
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
                        self.token_url.as_str(),
                        &[
                            ("client_id", &self.client_id),
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
                    return Ok(Credential::new(token, user, self.client_id.clone()));
                }
                Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(CANCELLATION_POLL_INTERVAL);
                }
                Err(_) => return Err(error(LoginErrorKind::Unavailable, "GitHub callback failed")),
            }
        }
    }

    fn refresh_token(&self, credential: &Credential) -> Result<Token, LoginError> {
        let response = self.post_form(
            self.token_url.as_str(),
            &[
                ("client_id", &self.client_id),
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
        })?;
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
            self.store_credential(&credential)?;
            Ok(credential.snapshot())
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
        if let Some(credential) = self.current_credential()?
            && credential.is_ready()
        {
            return Ok(BeginLogin::Connected {
                login_id: request.login_id,
                account: credential.snapshot(),
            });
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
        self.secrets
            .delete(&Self::credential_key())
            .map(|_| ())
            .map_err(|_| {
                error(
                    LoginErrorKind::Unavailable,
                    "GitHub credential store is unavailable",
                )
            })
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

#[derive(Deserialize, Serialize)]
struct Credential {
    #[serde(default)]
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: Option<u64>,
    refresh_expires_at: Option<u64>,
    account_id: String,
    login: String,
    credential_revision: u64,
}

impl Credential {
    fn new(token: Token, user: GitHubUser, client_id: String) -> Self {
        Self {
            client_id,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_at,
            refresh_expires_at: token.refresh_expires_at,
            account_id: user.id.to_string(),
            login: user.login,
            credential_revision: 1,
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
                account_id: self.account_id.clone(),
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
