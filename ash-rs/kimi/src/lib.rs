//! Native Kimi Code OAuth, local credential persistence, and authenticated API targets.

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
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use zeroize::Zeroize;

pub const KIMI_PROVIDER_ID: &str = "kimi-subscription";
pub const KIMI_CODE_API_BASE_URL: &str = "https://api.kimi.com/coding/v1";

const CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_AUTHORIZATION_URL: &str = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL: &str = "https://auth.kimi.com/api/oauth/token";
const CREDENTIAL_KEY: &str = "provider/kimi/current/oauth";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLL_DURATION: Duration = Duration::from_secs(15 * 60);
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Sanitized Kimi OAuth or credential failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KimiError {
    message: String,
}

impl KimiError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for KimiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for KimiError {}

/// Owns Kimi's device flow, local token lifecycle, and request-time credential projection.
pub struct KimiOAuth {
    client: Arc<dyn OperationClient>,
    secrets: Arc<dyn SecretStore>,
    self_weak: Weak<Self>,
    login_service: Mutex<Weak<LoginService>>,
    active: Mutex<BTreeMap<LoginId, CancellationSource>>,
    refresh: Mutex<()>,
    minimum_poll_interval: Duration,
}

impl KimiOAuth {
    pub fn production(secrets: Arc<dyn SecretStore>) -> Result<Arc<Self>, KimiError> {
        let transport = UreqHttpClient::new()
            .map_err(|_| KimiError::new("Kimi HTTPS transport is unavailable"))?;
        Ok(Self::with_client(
            secrets,
            Arc::new(AshClient::new(Arc::new(transport))),
        ))
    }

    pub fn with_client(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
    ) -> Arc<Self> {
        Self::with_client_and_poll_interval(secrets, client, DEFAULT_POLL_INTERVAL)
    }

    fn with_client_and_poll_interval(
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        minimum_poll_interval: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            client,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            refresh: Mutex::new(()),
            minimum_poll_interval,
        })
    }

    /// Connects asynchronous device-flow completion to the shared login control plane.
    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(login_lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    /// Resolves a fresh bearer target for one Kimi Coding API invocation.
    pub fn api_target(&self) -> Result<ResolvedApiTarget, KimiError> {
        let _refresh = self
            .refresh
            .lock()
            .map_err(|_| KimiError::new("Kimi credential refresh state is unavailable"))?;
        let mut credential = self
            .load_credential()?
            .ok_or_else(|| KimiError::new("Kimi Code is not signed in"))?;
        if credential.needs_refresh() {
            if credential.refresh_token.trim().is_empty() {
                return Err(KimiError::new("Kimi Code sign-in has expired"));
            }
            let mut refreshed = self.refresh_token(&credential)?;
            if refreshed.refresh_token.is_empty() {
                refreshed.refresh_token = std::mem::take(&mut credential.refresh_token);
            }
            refreshed.device_id = credential.device_id.clone();
            refreshed.credential_revision = credential.credential_revision.saturating_add(1);
            self.store_credential(&refreshed)?;
            self.publish_account_update(&refreshed);
            credential = refreshed;
        }
        Ok(ResolvedApiTarget::new(
            KIMI_CODE_API_BASE_URL,
            self.api_headers(&credential),
        ))
    }

    /// Reads whether the local Kimi Code subscription can be selected without refreshing it.
    pub fn subscription_ready(&self) -> Result<bool, KimiError> {
        Ok(self
            .load_credential()?
            .is_some_and(|credential| credential.is_usable()))
    }

    /// The login's device identity separates cached catalogs across Kimi sign-ins.
    pub fn subscription_catalog_identity(&self) -> Result<Option<String>, KimiError> {
        Ok(self
            .load_credential()?
            .filter(TokenCredential::is_usable)
            .map(|credential| credential.device_id.clone()))
    }

    fn request_device_code(
        &self,
        device_id: &str,
    ) -> Result<DeviceAuthorizationResponse, KimiError> {
        let cancellation = CancellationSource::new();
        let response = self.post_form(
            DEVICE_AUTHORIZATION_URL,
            &[("client_id", CLIENT_ID)],
            device_id,
            &cancellation.token(),
        )?;
        if !response.is_success() {
            return Err(KimiError::new(format!(
                "Kimi device authorization failed with HTTP {}",
                response.status()
            )));
        }
        let response: DeviceAuthorizationResponse = serde_json::from_slice(response.body())
            .map_err(|_| {
                KimiError::new("Kimi returned an invalid device authorization response")
            })?;
        if response.device_code.trim().is_empty()
            || response.user_code.trim().is_empty()
            || response.verification_uri().is_empty()
        {
            return Err(KimiError::new(
                "Kimi returned an incomplete device authorization response",
            ));
        }
        Ok(response)
    }

    fn poll_for_token(
        &self,
        device: &DeviceAuthorizationResponse,
        device_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<TokenCredential, KimiError> {
        let mut interval = Duration::from_secs(device.interval.unwrap_or_default())
            .max(self.minimum_poll_interval);
        let lifetime =
            Duration::from_secs(device.expires_in.unwrap_or(MAX_POLL_DURATION.as_secs()))
                .min(MAX_POLL_DURATION);
        let deadline = SystemTime::now() + lifetime;
        loop {
            wait_with_cancellation(interval, cancellation)?;
            if SystemTime::now() >= deadline {
                return Err(KimiError::new("Kimi device authorization expired"));
            }
            let response = self.post_form(
                TOKEN_URL,
                &[
                    ("client_id", CLIENT_ID),
                    ("device_code", device.device_code.as_str()),
                    ("grant_type", DEVICE_GRANT_TYPE),
                ],
                device_id,
                cancellation,
            )?;
            if !response.is_success() {
                return Err(KimiError::new(format!(
                    "Kimi token exchange failed with HTTP {}",
                    response.status()
                )));
            }
            let response: TokenResponse = serde_json::from_slice(response.body())
                .map_err(|_| KimiError::new("Kimi returned an invalid token response"))?;
            match response.error.as_deref() {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    interval = interval.saturating_add(Duration::from_secs(5));
                    continue;
                }
                Some("expired_token") => {
                    return Err(KimiError::new("Kimi device authorization expired"));
                }
                Some("access_denied") => {
                    return Err(KimiError::new("Kimi device authorization was denied"));
                }
                Some(_) => return Err(KimiError::new("Kimi device authorization failed")),
                None => return response.into_credential(device_id.to_owned(), 1),
            }
        }
    }

    fn refresh_token(&self, credential: &TokenCredential) -> Result<TokenCredential, KimiError> {
        let cancellation = CancellationSource::new();
        let response = self.post_form(
            TOKEN_URL,
            &[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", credential.refresh_token.as_str()),
            ],
            &credential.device_id,
            &cancellation.token(),
        )?;
        if !response.is_success() {
            return Err(KimiError::new(format!(
                "Kimi token refresh failed with HTTP {}",
                response.status()
            )));
        }
        let response: TokenResponse = serde_json::from_slice(response.body())
            .map_err(|_| KimiError::new("Kimi returned an invalid token refresh response"))?;
        if response.error.is_some() {
            return Err(KimiError::new("Kimi token refresh was rejected"));
        }
        response.into_credential(credential.device_id.clone(), credential.credential_revision)
    }

    fn post_form(
        &self,
        url: &str,
        fields: &[(&str, &str)],
        device_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<ash_client::ClientResponse, KimiError> {
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
        let request = ClientRequest::post(
            url,
            self.common_headers(device_id, "application/json"),
            body,
            RetryPolicy::never(),
        )
        .map_err(|_| KimiError::new("Kimi OAuth request could not be constructed"))?;
        self.client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| KimiError::new("Kimi OAuth service is unavailable"))
    }

    fn common_headers(&self, device_id: &str, accept: &str) -> Vec<HttpHeader> {
        vec![
            HttpHeader::new("Content-Type", "application/x-www-form-urlencoded"),
            HttpHeader::new("Accept", accept),
            HttpHeader::new("User-Agent", user_agent()),
            HttpHeader::new("X-Msh-Platform", "Ash"),
            HttpHeader::new("X-Msh-Version", env!("CARGO_PKG_VERSION")),
            HttpHeader::new("X-Msh-Device-Name", "Ash Desktop"),
            HttpHeader::new("X-Msh-Device-Model", device_model()),
            HttpHeader::new("X-Msh-Device-Id", device_id),
        ]
    }

    fn api_headers(&self, credential: &TokenCredential) -> Vec<HttpHeader> {
        vec![
            HttpHeader::new(
                "Authorization",
                format!("Bearer {}", credential.access_token),
            ),
            HttpHeader::new("User-Agent", user_agent()),
            HttpHeader::new("X-Msh-Platform", "Ash"),
            HttpHeader::new("X-Msh-Version", env!("CARGO_PKG_VERSION")),
            HttpHeader::new("X-Msh-Device-Name", "Ash Desktop"),
            HttpHeader::new("X-Msh-Device-Model", device_model()),
            HttpHeader::new("X-Msh-Device-Id", credential.device_id.as_str()),
        ]
    }

    fn credential_key() -> SecretKey {
        SecretKey::new(CREDENTIAL_KEY).expect("static Kimi credential key is valid")
    }

    fn load_credential(&self) -> Result<Option<TokenCredential>, KimiError> {
        self.secrets
            .load(&Self::credential_key())
            .map_err(|_| KimiError::new("Kimi credential store is unavailable"))?
            .map(|value| {
                serde_json::from_slice(value.expose())
                    .map_err(|_| KimiError::new("stored Kimi credential is invalid"))
            })
            .transpose()
    }

    fn store_credential(&self, credential: &TokenCredential) -> Result<(), KimiError> {
        let encoded = serde_json::to_vec(credential)
            .map_err(|_| KimiError::new("Kimi credential could not be encoded"))?;
        self.secrets
            .store(&Self::credential_key(), &SecretValue::new(encoded))
            .map_err(|_| KimiError::new("Kimi credential store is unavailable"))
    }

    fn account_snapshot(&self, credential: &TokenCredential) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: KIMI_PROVIDER_ID.into(),
                account_id: "current".into(),
            },
            email: None,
            display_name: Some("Kimi Code".into()),
            organization: None,
            plan: None,
            status: if credential.is_usable() {
                AccountStatus::Ready
            } else {
                AccountStatus::ReauthenticationRequired
            },
            credential_revision: credential.credential_revision,
        }
    }

    fn finish_login(&self, login_id: LoginId, outcome: LoginCompletionOutcome) {
        let active = self
            .active
            .lock()
            .map(|mut active| active.remove(&login_id).is_some())
            .unwrap_or(false);
        if !active {
            return;
        }
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

impl InteractiveLoginDriver for KimiOAuth {
    fn provider_id(&self) -> &'static str {
        KIMI_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        self.load_credential()
            .map(|credential| credential.map(|credential| self.account_snapshot(&credential)))
            .map_err(login_driver_error)
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        if request.method != LoginMethod::KimiDeviceCode {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "Kimi login supports only the device-code method",
            ));
        }
        if !self.active.lock().map_err(login_lock_error)?.is_empty() {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "a Kimi login is already active",
            ));
        }
        let device_id = random_device_id().map_err(login_driver_error)?;
        let device = self
            .request_device_code(&device_id)
            .map_err(login_driver_error)?;
        let cancellation = CancellationSource::new();
        self.active
            .lock()
            .map_err(login_lock_error)?
            .insert(request.login_id.clone(), cancellation.clone());
        let weak = self.self_weak.clone();
        let login_id = request.login_id.clone();
        let worker_device = device.clone();
        thread::spawn(move || {
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            let outcome = runtime.poll_for_token(&worker_device, &device_id, &cancellation.token());
            if cancellation.token().is_cancelled() {
                return;
            }
            match outcome {
                Ok(credential) => {
                    let completion = match runtime.store_credential(&credential) {
                        Ok(()) => LoginCompletionOutcome::Succeeded {
                            account: runtime.account_snapshot(&credential),
                        },
                        Err(error) => LoginCompletionOutcome::Failed {
                            failure: LoginFailure {
                                code: "credential_store_failed".into(),
                                message: error.to_string(),
                            },
                        },
                    };
                    runtime.finish_login(login_id, completion);
                }
                Err(error) => runtime.finish_login(
                    login_id,
                    LoginCompletionOutcome::Failed {
                        failure: LoginFailure {
                            code: "oauth_failed".into(),
                            message: error.to_string(),
                        },
                    },
                ),
            }
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
        if account.provider != KIMI_PROVIDER_ID {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "account is not owned by the Kimi login driver",
            ));
        }
        self.secrets
            .delete(&Self::credential_key())
            .map(|_| ())
            .map_err(|_| {
                LoginError::new(
                    LoginErrorKind::Unavailable,
                    "Kimi credential store is unavailable",
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
    verification_uri_complete: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    interval: Option<u64>,
}

impl DeviceAuthorizationResponse {
    fn verification_uri(&self) -> &str {
        if self.verification_uri_complete.trim().is_empty() {
            self.verification_uri.trim()
        } else {
            self.verification_uri_complete.trim()
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    expires_in: f64,
}

impl TokenResponse {
    fn into_credential(
        mut self,
        device_id: String,
        credential_revision: u64,
    ) -> Result<TokenCredential, KimiError> {
        if self.access_token.trim().is_empty() {
            return Err(KimiError::new("Kimi returned an empty access token"));
        }
        Ok(TokenCredential {
            access_token: std::mem::take(&mut self.access_token),
            refresh_token: std::mem::take(&mut self.refresh_token),
            token_type: std::mem::take(&mut self.token_type),
            scope: std::mem::take(&mut self.scope),
            expires_at: (self.expires_in > 0.0)
                .then(|| now_epoch_seconds().saturating_add(self.expires_in as u64)),
            device_id,
            credential_revision,
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

#[derive(Deserialize, Serialize)]
struct TokenCredential {
    access_token: String,
    refresh_token: String,
    token_type: String,
    scope: String,
    expires_at: Option<u64>,
    device_id: String,
    credential_revision: u64,
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
        self.device_id.zeroize();
    }
}

fn wait_with_cancellation(
    duration: Duration,
    cancellation: &CancellationToken,
) -> Result<(), KimiError> {
    let mut remaining = duration;
    while !remaining.is_zero() {
        if cancellation.is_cancelled() {
            return Err(KimiError::new("Kimi device authorization was cancelled"));
        }
        let slice = remaining.min(CANCELLATION_POLL_INTERVAL);
        thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    cancellation
        .check()
        .map_err(|_| KimiError::new("Kimi device authorization was cancelled"))
}

fn random_device_id() -> Result<String, KimiError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| KimiError::new("Kimi device identity could not be generated"))?;
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

fn device_model() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn login_driver_error(error: KimiError) -> LoginError {
    LoginError::new(LoginErrorKind::Driver, error.to_string())
}

fn login_lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "Kimi login state is unavailable",
    )
}

#[cfg(test)]
#[path = "kimi_tests.rs"]
mod tests;
