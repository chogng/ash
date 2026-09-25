//! xAI subscription device authorization, credential storage, and authenticated proxy requests.

use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::AshClient;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::UreqHttpClient;
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
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use zeroize::Zeroize;

pub const XAI_PROVIDER_ID: &str = "xai-subscription";
pub use backend_client::xai::BASE_URL as XAI_SUBSCRIPTION_API_BASE_URL;

/// Grok's credential file on the backend host, if its home directory is known.
pub fn grok_auth_path() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| std::path::PathBuf::from(home).join(".grok/auth.json"))
}

mod account;
pub use account::Subscription;
pub use backend_client::xai::CatalogModel;

const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_AUTHORIZATION_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
// Grok Build compatibility target, independent of Ash's product version.
// Reviewed wire contract: xai-org/grok-build@4247f661689354b831191f11eeeac8424993fe3d,
// crates/codegen/xai-grok-version/Cargo.toml. Re-review the contract before updating.
// This is an adapter compatibility policy, not a published third-party API version.
const GROK_BUILD_VERSION: &str = "1.0.38";
const CREDENTIAL_KEY: &str = "provider/xai/current/oauth";
const DISCONNECTED_KEY: &str = "provider/xai/disconnected";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLL_DURATION: Duration = Duration::from_secs(15 * 60);
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Sanitized Xai OAuth or credential failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct XaiError {
    message: String,
    kind: XaiErrorKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum XaiErrorKind {
    Cancelled,
    AccountChanged,
    Authentication,
    Permission,
    UpgradeRequired,
    RateLimited,
    InvalidResponse,
    Unavailable,
}

impl XaiError {
    pub fn kind(&self) -> XaiErrorKind {
        self.kind
    }
    fn with_kind(kind: XaiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: XaiErrorKind::Unavailable,
        }
    }
}

impl fmt::Display for XaiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for XaiError {}

/// One request's bearer target and non-secret login identity.
pub struct XaiApiTarget {
    pub target: ResolvedApiTarget,
    pub account_id: String,
    pub credential_revision: u64,
}

/// Owns Xai's device flow, local token lifecycle, and request-time authentication.
pub struct XaiOAuth {
    client: Arc<dyn OperationClient>,
    secrets: Arc<dyn SecretStore>,
    self_weak: Weak<Self>,
    login_service: Mutex<Weak<LoginService>>,
    active: Mutex<BTreeMap<LoginId, CancellationSource>>,
    refresh: Mutex<()>,
    account_reads: AtomicU64,
    lock_path: std::path::PathBuf,
    grok_auth_path: Option<std::path::PathBuf>,
    rejected_grok: Mutex<Option<(String, u64)>>,
    minimum_poll_interval: Duration,
}

impl XaiOAuth {
    pub fn production(
        secrets: Arc<dyn SecretStore>,
        lock_path: std::path::PathBuf,
    ) -> Result<Arc<Self>, XaiError> {
        let transport = UreqHttpClient::new()
            .map_err(|_| XaiError::new("Xai HTTPS transport is unavailable"))?;
        Ok(Self::with_host_grok_auth(
            secrets,
            Arc::new(AshClient::new(Arc::new(transport))),
            lock_path,
        ))
    }

    /// Uses the Grok login on this backend host when Ash has no own xAI login.
    fn with_host_grok_auth(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        lock_path: std::path::PathBuf,
    ) -> Arc<Self> {
        let grok_auth_path = grok_auth_path();
        Self::with_client_and_grok_auth(
            secrets,
            client,
            lock_path,
            grok_auth_path,
            DEFAULT_POLL_INTERVAL,
        )
    }

    /// Reads one explicitly selected Grok credential file without modifying it.
    pub fn with_grok_auth_file(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        lock_path: std::path::PathBuf,
        grok_auth_path: std::path::PathBuf,
    ) -> Arc<Self> {
        Self::with_client_and_grok_auth(
            secrets,
            client,
            lock_path,
            Some(grok_auth_path),
            DEFAULT_POLL_INTERVAL,
        )
    }

    pub fn with_client(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        lock_path: std::path::PathBuf,
    ) -> Arc<Self> {
        Self::with_client_and_poll_interval(secrets, client, lock_path, DEFAULT_POLL_INTERVAL)
    }

    fn with_client_and_poll_interval(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        lock_path: std::path::PathBuf,
        minimum_poll_interval: Duration,
    ) -> Arc<Self> {
        Self::with_client_and_grok_auth(secrets, client, lock_path, None, minimum_poll_interval)
    }

    fn with_client_and_grok_auth(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        lock_path: std::path::PathBuf,
        grok_auth_path: Option<std::path::PathBuf>,
        minimum_poll_interval: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            client,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            refresh: Mutex::new(()),
            account_reads: AtomicU64::new(0),
            lock_path,
            grok_auth_path,
            rejected_grok: Mutex::new(None),
            minimum_poll_interval,
        })
    }

    /// Connects asynchronous device-flow completion to the shared login control plane.
    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(login_lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    /// Resolves a fresh bearer target for one xAI subscription invocation.
    pub fn api_target(&self) -> Result<XaiApiTarget, XaiError> {
        let _refresh = self.lock_credentials()?;
        let mut credential = self.active_credential()?.ok_or_else(|| {
            XaiError::with_kind(
                XaiErrorKind::Authentication,
                "xAI Subscription is not signed in",
            )
        })?;
        if self.grok_rejected(&credential) {
            return Err(XaiError::with_kind(
                XaiErrorKind::Authentication,
                "Grok sign-in has expired; sign in with xAI in Ash",
            ));
        }
        if credential.needs_refresh() {
            if credential.refresh_token.trim().is_empty() {
                return Err(XaiError::with_kind(
                    XaiErrorKind::Authentication,
                    "xAI Subscription sign-in has expired",
                ));
            }
            credential = self.renew_credential(credential)?;
        }
        Ok(XaiApiTarget {
            target: ResolvedApiTarget::new(
                XAI_SUBSCRIPTION_API_BASE_URL,
                self.api_headers(&credential),
            ),
            account_id: credential.account_id.clone(),
            credential_revision: credential.credential_revision,
        })
    }

    /// Reads the local catalog scope without refreshing or exposing a token.
    pub fn account_id(&self) -> Result<Option<String>, XaiError> {
        Ok(self
            .active_credential()?
            .map(|credential| credential.account_id.clone()))
    }

    /// Reads subscription readiness from the current local credential without a network call.
    pub fn subscription_ready(&self) -> Result<bool, XaiError> {
        Ok(self
            .active_credential()?
            .is_some_and(|credential| credential.is_usable() && !self.grok_rejected(&credential)))
    }

    /// Refreshes a rejected credential at most once, without crossing a login boundary.
    pub fn recover_unauthorized(
        &self,
        rejected: &XaiApiTarget,
    ) -> Result<Option<XaiApiTarget>, XaiError> {
        if is_grok_account(&rejected.account_id) {
            let Some(credential) = self.active_credential()? else {
                return Ok(None);
            };
            if credential.account_id != rejected.account_id
                || credential.credential_revision == rejected.credential_revision
                || !credential.is_usable()
            {
                return Ok(None);
            }
            return Ok(Some(XaiApiTarget {
                target: ResolvedApiTarget::new(
                    XAI_SUBSCRIPTION_API_BASE_URL,
                    self.api_headers(&credential),
                ),
                account_id: credential.account_id.clone(),
                credential_revision: credential.credential_revision,
            }));
        }
        let _refresh = self.lock_credentials()?;
        let Some(mut credential) = self.load_credential()? else {
            return Ok(None);
        };
        if credential.account_id != rejected.account_id || !credential.is_usable() {
            return Ok(None);
        }
        if credential.credential_revision == rejected.credential_revision {
            if credential.refresh_token.is_empty() {
                return Ok(None);
            }
            credential = self.renew_credential(credential)?;
        }
        Ok(Some(XaiApiTarget {
            target: ResolvedApiTarget::new(
                XAI_SUBSCRIPTION_API_BASE_URL,
                self.api_headers(&credential),
            ),
            account_id: credential.account_id.clone(),
            credential_revision: credential.credential_revision,
        }))
    }

    fn renew_credential(
        &self,
        mut credential: TokenCredential,
    ) -> Result<TokenCredential, XaiError> {
        // Persist consumption before using a rotating token. A transport or storage
        // failure must never let another process submit the same token again.
        let mut consumed = self.load_credential()?.ok_or_else(|| {
            XaiError::with_kind(XaiErrorKind::Authentication, "xAI is signed out")
        })?;
        consumed.access_token.zeroize();
        consumed.refresh_token.zeroize();
        consumed.expires_at = Some(0);
        self.store_credential(&consumed)?;
        let mut refreshed = self
            .refresh_token(&credential)
            .inspect_err(|_| self.publish_account_update(&consumed))?;
        if refreshed.refresh_token.is_empty() {
            refreshed.refresh_token = std::mem::take(&mut credential.refresh_token);
        }
        refreshed.profile = credential.profile.clone();
        refreshed.account_id = credential.account_id.clone();
        refreshed.credential_revision = credential.credential_revision.saturating_add(1);
        self.store_credential(&refreshed)?;
        self.publish_account_update(&refreshed);
        Ok(refreshed)
    }

    fn lock_credentials(&self) -> Result<(std::sync::MutexGuard<'_, ()>, std::fs::File), XaiError> {
        let guard = self
            .refresh
            .lock()
            .map_err(|_| XaiError::new("xAI credential state is unavailable"))?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.lock_path)
            .map_err(|_| XaiError::new("xAI credential lock is unavailable"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok((guard, file)),
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && std::time::Instant::now() < deadline =>
                {
                    thread::sleep(CANCELLATION_POLL_INTERVAL)
                }
                Err(_) => {
                    return Err(XaiError::new(
                        "xAI credentials are busy in another Ash process",
                    ));
                }
            }
        }
    }

    pub fn note_rejected(&self, rejected: &XaiApiTarget) {
        if is_grok_account(&rejected.account_id) {
            if let Ok(mut current) = self.rejected_grok.lock() {
                *current = Some((rejected.account_id.clone(), rejected.credential_revision));
            }
            return;
        }
        let Ok(_lock) = self.lock_credentials() else {
            return;
        };
        let Ok(Some(mut credential)) = self.load_credential() else {
            return;
        };
        if credential.account_id == rejected.account_id
            && credential.credential_revision == rejected.credential_revision
        {
            credential.refresh_token.zeroize();
            credential.access_token.zeroize();
            credential.expires_at = Some(0);
            if self.store_credential(&credential).is_ok() {
                self.publish_account_update(&credential);
            }
        }
    }

    fn request_device_code(&self) -> Result<DeviceAuthorizationResponse, XaiError> {
        let cancellation = CancellationSource::new();
        let response = self.post_form(
            DEVICE_AUTHORIZATION_URL,
            &[
                ("client_id", CLIENT_ID),
                (
                    "scope",
                    "openid profile email offline_access grok-cli:access api:access",
                ),
                ("referrer", "ash"),
            ],
            &cancellation.token(),
        )?;
        if !response.is_success() {
            return Err(XaiError::new(format!(
                "Xai device authorization failed with HTTP {}",
                response.status()
            )));
        }
        let response: DeviceAuthorizationResponse = serde_json::from_slice(response.body())
            .map_err(|_| XaiError::new("Xai returned an invalid device authorization response"))?;
        if response.device_code.trim().is_empty()
            || response.user_code.trim().is_empty()
            || !response
                .user_code
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
            || response.verification_uri().chars().any(char::is_control)
            || !url::Url::parse(response.verification_uri())
                .is_ok_and(|url| url.scheme() == "https")
        {
            return Err(XaiError::new(
                "Xai returned an incomplete device authorization response",
            ));
        }
        Ok(response)
    }

    fn poll_for_token(
        &self,
        device: &DeviceAuthorizationResponse,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<TokenCredential, XaiError> {
        let mut interval = Duration::from_secs(device.interval.unwrap_or_default())
            .max(self.minimum_poll_interval);
        let lifetime =
            Duration::from_secs(device.expires_in.unwrap_or(MAX_POLL_DURATION.as_secs()))
                .min(MAX_POLL_DURATION);
        let deadline = SystemTime::now() + lifetime;
        loop {
            wait_with_cancellation(interval, cancellation)?;
            if SystemTime::now() >= deadline {
                return Err(XaiError::new("Xai device authorization expired"));
            }
            let response = self.post_form(
                TOKEN_URL,
                &[
                    ("client_id", CLIENT_ID),
                    ("device_code", device.device_code.as_str()),
                    ("grant_type", DEVICE_GRANT_TYPE),
                ],
                cancellation,
            )?;
            let status = response.status();
            let response: TokenResponse = serde_json::from_slice(response.body())
                .map_err(|_| XaiError::new("Xai returned an invalid token response"))?;
            match response.error.as_deref() {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    interval = interval.saturating_add(Duration::from_secs(5));
                    continue;
                }
                Some("expired_token") => {
                    return Err(XaiError::new("Xai device authorization expired"));
                }
                Some("access_denied") => {
                    return Err(XaiError::new("Xai device authorization was denied"));
                }
                Some(_) => return Err(XaiError::new("Xai device authorization failed")),
                None if (200..300).contains(&status) => {
                    return response.into_credential(account_id.to_owned(), 1);
                }
                None => {
                    return Err(XaiError::new(format!(
                        "xAI token exchange failed with HTTP {status}"
                    )));
                }
            }
        }
    }

    fn refresh_token(&self, credential: &TokenCredential) -> Result<TokenCredential, XaiError> {
        let cancellation = CancellationSource::new();
        let response = self.post_form(
            TOKEN_URL,
            &[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", credential.refresh_token.as_str()),
            ],
            &cancellation.token(),
        )?;
        let status = response.status();
        let response: TokenResponse = serde_json::from_slice(response.body())
            .map_err(|_| XaiError::new("xAI returned an invalid token refresh response"))?;
        if response.error.as_deref() == Some("invalid_grant") {
            return Err(XaiError::with_kind(
                XaiErrorKind::Authentication,
                "xAI sign-in has expired; sign in again",
            ));
        }
        if !(200..300).contains(&status) || response.error.is_some() {
            return Err(XaiError::new(format!(
                "xAI token refresh failed with HTTP {status}"
            )));
        }
        response.into_credential(
            credential.account_id.clone(),
            credential.credential_revision,
        )
    }

    fn post_form(
        &self,
        url: &str,
        fields: &[(&str, &str)],
        cancellation: &CancellationToken,
    ) -> Result<ash_client::ClientResponse, XaiError> {
        let body = fields
            .iter()
            .map(|(name, value)| {
                format!(
                    "{}={}",
                    urlencoding::encode(name),
                    urlencoding::encode(value)
                )
            })
            .collect::<Vec<_>>()
            .join("&")
            .into_bytes();
        let request = ClientRequest::post(url, self.common_headers(), body, RetryPolicy::never())
            .map_err(|_| XaiError::new("Xai OAuth request could not be constructed"))?;
        self.client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| XaiError::new("Xai OAuth service is unavailable"))
    }

    fn common_headers(&self) -> Vec<HttpHeader> {
        vec![
            HttpHeader::new("Content-Type", "application/x-www-form-urlencoded"),
            HttpHeader::new("Accept", "application/json"),
            HttpHeader::new("User-Agent", user_agent()),
            HttpHeader::new("x-grok-client-version", GROK_BUILD_VERSION),
            HttpHeader::new("x-grok-client-surface", "ui"),
        ]
    }

    fn api_headers(&self, credential: &TokenCredential) -> Vec<HttpHeader> {
        let mut headers = vec![
            HttpHeader::new(
                "Authorization",
                format!("Bearer {}", credential.access_token),
            ),
            HttpHeader::new("User-Agent", user_agent()),
            HttpHeader::new("x-grok-client-identifier", "ash"),
            HttpHeader::new("x-grok-client-version", GROK_BUILD_VERSION),
            HttpHeader::new("X-XAI-Token-Auth", "xai-grok-cli"),
            HttpHeader::new("x-authenticateresponse", "authenticate-response"),
            HttpHeader::new("x-grok-client-mode", "headless"),
        ];
        if let Some(profile) = &credential.profile {
            headers.push(HttpHeader::new("x-userid", &profile.user_id));
            if let Some(email) = &profile.email {
                headers.push(HttpHeader::new("x-email", email));
            }
        }
        headers
    }

    fn credential_key() -> SecretKey {
        SecretKey::new(CREDENTIAL_KEY).expect("static Xai credential key is valid")
    }

    fn disconnected_key() -> SecretKey {
        SecretKey::new(DISCONNECTED_KEY).expect("static Xai disconnection key is valid")
    }

    fn disconnected(&self) -> Result<bool, XaiError> {
        self.secrets
            .load(&Self::disconnected_key())
            .map(|value| value.is_some())
            .map_err(|_| XaiError::new("Xai connection state is unavailable"))
    }

    fn active_credential(&self) -> Result<Option<TokenCredential>, XaiError> {
        if self.disconnected()? {
            return Ok(None);
        }
        self.candidate_credential()
    }

    fn candidate_credential(&self) -> Result<Option<TokenCredential>, XaiError> {
        match self.load_credential()? {
            Some(credential) => Ok(Some(credential)),
            None => self.load_grok_credential(),
        }
    }

    fn load_grok_credential(&self) -> Result<Option<TokenCredential>, XaiError> {
        let Some(path) = &self.grok_auth_path else {
            return Ok(None);
        };
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(XaiError::new("Grok credential file could not be read")),
        };
        let mut contents = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut contents)
            .map_err(|_| XaiError::new("Grok credential file could not be read"))?;
        let bytes = SecretValue::new(contents);
        if bytes.expose().len() > 1024 * 1024 {
            return Err(XaiError::new("Grok credential file is too large"));
        }
        let GrokCredentialMap(entry) = serde_json::from_slice(bytes.expose())
            .map_err(|_| XaiError::new("Grok credential file is invalid"))?;
        let Some(entry) = entry else {
            return Ok(None);
        };
        entry.into_credential()
    }

    fn grok_rejected(&self, credential: &TokenCredential) -> bool {
        is_grok_account(&credential.account_id)
            && self.rejected_grok.lock().map_or(true, |rejected| {
                matches!(rejected.as_ref(), Some((account_id, revision))
                    if account_id == &credential.account_id
                        && *revision == credential.credential_revision)
            })
    }

    fn load_credential(&self) -> Result<Option<TokenCredential>, XaiError> {
        self.secrets
            .load(&Self::credential_key())
            .map_err(|_| XaiError::new("Xai credential store is unavailable"))?
            .map(|value| {
                serde_json::from_slice(value.expose())
                    .map_err(|_| XaiError::new("stored Xai credential is invalid"))
            })
            .transpose()
    }

    fn store_credential(&self, credential: &TokenCredential) -> Result<(), XaiError> {
        let encoded = serde_json::to_vec(credential)
            .map_err(|_| XaiError::new("Xai credential could not be encoded"))?;
        self.secrets
            .store(&Self::credential_key(), &SecretValue::new(encoded))
            .map_err(|_| XaiError::new("Xai credential store is unavailable"))
    }

    fn account_snapshot(&self, credential: &TokenCredential) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: XAI_PROVIDER_ID.into(),
                account_id: credential.account_id.clone(),
            },
            email: credential
                .profile
                .as_ref()
                .and_then(|profile| profile.email.clone())
                .or_else(|| credential.grok_email.clone()),
            display_name: credential.profile.as_ref().and_then(|profile| {
                let name = [profile.first_name.as_deref(), profile.last_name.as_deref()]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                (!name.is_empty()).then_some(name)
            }),
            organization: credential
                .profile
                .as_ref()
                .and_then(|profile| profile.organization_name.clone()),
            plan: credential
                .profile
                .as_ref()
                .and_then(|profile| profile.subscription_tier.clone()),
            status: if credential.is_usable() && !self.grok_rejected(credential) {
                AccountStatus::Ready
            } else {
                AccountStatus::ReauthenticationRequired
            },
            credential_revision: credential.credential_revision,
        }
    }

    fn finish_login(&self, login_id: LoginId, outcome: LoginCompletionOutcome) {
        let service = self
            .login_service
            .lock()
            .ok()
            .and_then(|service| service.upgrade());
        if let Some(service) = service {
            let _ = service.complete(CompleteLogin { login_id, outcome });
        }
    }

    fn publish_account_update(&self, credential: &TokenCredential) {
        let service = self
            .login_service
            .lock()
            .ok()
            .and_then(|service| service.upgrade());
        if let Some(service) = service {
            let _ = service.update_account(self.account_snapshot(credential));
        }
    }
}

impl InteractiveLoginDriver for XaiOAuth {
    fn provider_id(&self) -> &'static str {
        XAI_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        self.active_credential()
            .map(|credential| credential.map(|credential| self.account_snapshot(&credential)))
            .map_err(login_driver_error)
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        if request.method != LoginMethod::XaiDeviceCode {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "Xai login supports only the device-code method",
            ));
        }
        let mut active = self.active.lock().map_err(login_lock_error)?;
        if !active.is_empty() {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "a Xai login is already active",
            ));
        }
        if let Some(credential) = self.candidate_credential().map_err(login_driver_error)? {
            if credential.is_usable() && !self.grok_rejected(&credential) {
                self.secrets
                    .delete(&Self::disconnected_key())
                    .map_err(|_| {
                        login_driver_error(XaiError::new("Xai connection state is unavailable"))
                    })?;
                return Ok(BeginLogin::Connected {
                    login_id: request.login_id,
                    account: self.account_snapshot(&credential),
                });
            }
        }
        let account_id = random_account_id().map_err(login_driver_error)?;
        let device = self.request_device_code().map_err(login_driver_error)?;
        let cancellation = CancellationSource::new();
        active.insert(request.login_id.clone(), cancellation.clone());
        drop(active);
        let weak = self.self_weak.clone();
        let login_id = request.login_id.clone();
        let worker_device = device.clone();
        thread::spawn(move || {
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            let outcome =
                runtime.poll_for_token(&worker_device, &account_id, &cancellation.token());
            let _refresh = runtime.lock_credentials();
            let outcome = match &_refresh {
                Ok(_) => outcome,
                Err(error) => Err(error.clone()),
            };
            let Ok(mut active) = runtime.active.lock() else {
                return;
            };
            if cancellation.token().is_cancelled() || active.remove(&login_id).is_none() {
                return;
            }
            let completion = match outcome.and_then(|credential| {
                runtime.store_credential(&credential)?;
                runtime
                    .secrets
                    .delete(&Self::disconnected_key())
                    .map_err(|_| XaiError::new("Xai connection state is unavailable"))?;
                Ok(runtime.account_snapshot(&credential))
            }) {
                Ok(account) => LoginCompletionOutcome::Succeeded { account },
                Err(error) => LoginCompletionOutcome::Failed {
                    failure: LoginFailure {
                        code: "oauth_failed".into(),
                        message: error.to_string(),
                    },
                },
            };
            runtime.finish_login(login_id, completion);
        });
        Ok(BeginLogin::DeviceCode {
            login_id: request.login_id,
            verification_url: device.verification_uri().to_owned(),
            user_code: device.user_code,
        })
    }

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let source = self
            .active
            .lock()
            .map_err(login_lock_error)?
            .remove(login_id);
        let Some(source) = source else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        source.cancel();
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        if account.provider != XAI_PROVIDER_ID {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "account is not owned by the Xai login driver",
            ));
        }
        let _refresh = self.lock_credentials().map_err(login_driver_error)?;
        let mut active = self.active.lock().map_err(login_lock_error)?;
        for (_, source) in std::mem::take(&mut *active) {
            source.cancel();
        }
        self.secrets
            .store(&Self::disconnected_key(), &SecretValue::new(b"1".to_vec()))
            .map_err(|_| {
                LoginError::new(
                    LoginErrorKind::Unavailable,
                    "Xai connection state is unavailable",
                )
            })?;
        self.secrets
            .delete(&Self::credential_key())
            .map(|_| ())
            .map_err(|_| {
                LoginError::new(
                    LoginErrorKind::Unavailable,
                    "Xai credential store is unavailable",
                )
            })
    }
}

#[derive(Clone, Deserialize)]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    #[serde(default)]
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    interval: Option<u64>,
}

impl DeviceAuthorizationResponse {
    fn verification_uri(&self) -> &str {
        self.verification_uri_complete
            .as_deref()
            .unwrap_or(&self.verification_uri)
            .trim()
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    expires_in: Option<f64>,
}

impl TokenResponse {
    fn into_credential(
        mut self,
        account_id: String,
        credential_revision: u64,
    ) -> Result<TokenCredential, XaiError> {
        if self.access_token.trim().is_empty()
            || self
                .expires_in
                .is_some_and(|seconds| !seconds.is_finite() || seconds <= 0.0)
            || self
                .token_type
                .as_deref()
                .is_some_and(|kind| !kind.eq_ignore_ascii_case("bearer"))
        {
            return Err(XaiError::new("xAI returned an invalid token response"));
        }
        Ok(TokenCredential {
            access_token: std::mem::take(&mut self.access_token),
            refresh_token: self.refresh_token.take().unwrap_or_default(),
            token_type: self.token_type.take().unwrap_or_else(|| "Bearer".into()),
            scope: self.scope.take().unwrap_or_default(),
            expires_at: self
                .expires_in
                .map(|seconds| now_epoch_seconds().saturating_add(seconds as u64)),
            account_id,
            credential_revision,
            profile: None,
            grok_email: None,
            grok_identity: None,
        })
    }
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.error.zeroize();
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.token_type.zeroize();
        self.scope.zeroize();
    }
}

#[derive(Deserialize)]
struct GrokCredential {
    key: String,
    auth_mode: String,
    user_id: String,
    principal_id: String,
    team_id: String,
    email: Option<String>,
    expires_at: String,
}

struct GrokCredentialMap(Option<GrokCredential>);

impl<'de> Deserialize<'de> for GrokCredentialMap {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct MapVisitor;

        impl<'de> serde::de::Visitor<'de> for MapVisitor {
            type Value = GrokCredentialMap;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a Grok credential map")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut selected = None;
                let expected = format!("https://auth.x.ai::{CLIENT_ID}");
                while let Some(key) = map.next_key::<String>()? {
                    if key == expected {
                        selected = Some(map.next_value::<GrokCredential>()?);
                    } else {
                        map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                Ok(GrokCredentialMap(selected))
            }
        }

        deserializer.deserialize_map(MapVisitor)
    }
}

impl GrokCredential {
    fn into_credential(mut self) -> Result<Option<TokenCredential>, XaiError> {
        if self.auth_mode != "oidc" {
            return Ok(None);
        }
        if self.key.trim().is_empty()
            || self.user_id.trim().is_empty()
            || self.principal_id.trim().is_empty()
            || self.team_id.trim().is_empty()
        {
            return Err(XaiError::new("Grok credential is incomplete"));
        }
        let expires_at = chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .ok()
            .and_then(|time| u64::try_from(time.timestamp()).ok())
            .ok_or_else(|| XaiError::new("Grok credential expiry is invalid"))?;
        let revision = Sha256::digest(self.key.as_bytes());
        Ok(Some(TokenCredential {
            profile: None,
            access_token: std::mem::take(&mut self.key),
            refresh_token: String::new(),
            token_type: "Bearer".into(),
            scope: String::new(),
            expires_at: Some(expires_at),
            account_id: grok_account_id(&self.user_id, &self.principal_id, &self.team_id),
            credential_revision: u64::from_be_bytes(revision[..8].try_into().unwrap()),
            grok_email: self.email.take(),
            grok_identity: Some(GrokIdentity {
                user_id: std::mem::take(&mut self.user_id),
                principal_id: std::mem::take(&mut self.principal_id),
                team_id: std::mem::take(&mut self.team_id),
            }),
        }))
    }
}

impl Drop for GrokCredential {
    fn drop(&mut self) {
        self.key.zeroize();
        self.user_id.zeroize();
        self.principal_id.zeroize();
        self.team_id.zeroize();
        self.email.zeroize();
    }
}

fn is_grok_account(account_id: &str) -> bool {
    account_id.starts_with("grok-")
}

fn grok_account_id(user_id: &str, principal_id: &str, team_id: &str) -> String {
    let mut identity = Sha256::new();
    for part in [user_id, principal_id, team_id] {
        identity.update((part.len() as u64).to_be_bytes());
        identity.update(part.as_bytes());
    }
    format!("grok-{:x}", identity.finalize())
}

struct GrokIdentity {
    user_id: String,
    principal_id: String,
    team_id: String,
}

impl Drop for GrokIdentity {
    fn drop(&mut self) {
        self.user_id.zeroize();
        self.principal_id.zeroize();
        self.team_id.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
struct TokenCredential {
    #[serde(default)]
    profile: Option<backend_client::xai::Account>,
    access_token: String,
    refresh_token: String,
    token_type: String,
    scope: String,
    expires_at: Option<u64>,
    account_id: String,
    credential_revision: u64,
    #[serde(skip)]
    grok_email: Option<String>,
    #[serde(skip)]
    grok_identity: Option<GrokIdentity>,
}

impl TokenCredential {
    fn needs_refresh(&self) -> bool {
        self.expires_at.is_some_and(|expires_at| {
            expires_at <= now_epoch_seconds().saturating_add(REFRESH_MARGIN.as_secs())
        })
    }

    fn is_usable(&self) -> bool {
        !self.access_token.trim().is_empty()
            && (!self.needs_refresh() || !self.refresh_token.trim().is_empty())
    }
}

impl Drop for TokenCredential {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.token_type.zeroize();
        self.scope.zeroize();
        self.account_id.zeroize();
        self.grok_email.zeroize();
    }
}

fn wait_with_cancellation(
    duration: Duration,
    cancellation: &CancellationToken,
) -> Result<(), XaiError> {
    let mut remaining = duration;
    while !remaining.is_zero() {
        if cancellation.is_cancelled() {
            return Err(XaiError::new("Xai device authorization was cancelled"));
        }
        let slice = remaining.min(CANCELLATION_POLL_INTERVAL);
        thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    cancellation
        .check()
        .map_err(|_| XaiError::new("Xai device authorization was cancelled"))
}

fn random_account_id() -> Result<String, XaiError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| XaiError::new("Xai device identity could not be generated"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

fn user_agent() -> String {
    format!("Ash/{}", env!("CARGO_PKG_VERSION"))
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn login_driver_error(error: XaiError) -> LoginError {
    LoginError::new(LoginErrorKind::Driver, error.to_string())
}

fn login_lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "Xai login state is unavailable",
    )
}

#[cfg(test)]
#[path = "xai_tests.rs"]
mod tests;
