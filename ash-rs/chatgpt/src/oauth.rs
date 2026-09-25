use crate::ChatGptAuthManagement;
use crate::credential::AccountIdentity;
use crate::credential::TokenCredential;
use crate::credential::TokenResponse;
use crate::device_flow;
use crate::maintenance::AuthMaintenance;
use crate::maintenance::RefreshReason;
use crate::storage::CodexAuthStore;
use crate::storage::LoginWrite;
use ash_async_utils::CancellationSource;
use ash_client::AshClient;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
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
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::thread;

pub const CHATGPT_SUBSCRIPTION_PROVIDER_ID: &str = "chatgpt-subscription";
pub const CHATGPT_RESPONSES_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

pub(crate) const AUTH_BASE_URL: &str = "https://auth.openai.com";
pub(crate) const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DISCONNECTED_KEY: &str = "provider/chatgpt-subscription/disconnected";
const LEGACY_DISCONNECTED_KEY: &str = "provider/openai-chatgpt/disconnected";

/// Sanitized ChatGPT OAuth or credential failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatGptError {
    message: String,
}

impl ChatGptError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ChatGptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ChatGptError {}

/// Authentication for one request, bound to its original user and workspace.
pub struct ChatGptApiTarget {
    target: ResolvedApiTarget,
    pub(crate) identity: AccountIdentity,
    revision: [u8; 32],
}

impl ChatGptApiTarget {
    pub fn api_target(&self) -> &ResolvedApiTarget {
        &self.target
    }

    pub fn into_api_target(self) -> ResolvedApiTarget {
        self.target
    }

    fn new(base_url: &str, credential: &TokenCredential) -> Result<Self, ChatGptError> {
        Ok(Self {
            target: ResolvedApiTarget::new(base_url, api_headers(credential)),
            identity: credential.identity()?,
            revision: credential.storage_revision,
        })
    }
}

/// Maintains ChatGPT authentication when Codex is absent and otherwise reuses its credentials.
pub struct ChatGptOAuth {
    pub(crate) client: Arc<dyn OperationClient>,
    secrets: Arc<dyn SecretStore>,
    self_weak: Weak<Self>,
    login_service: Mutex<Weak<LoginService>>,
    active: Mutex<BTreeMap<LoginId, CancellationSource>>,
    auth: CodexAuthStore,
    maintenance: AuthMaintenance,
}

impl ChatGptOAuth {
    pub fn production(
        codex_home: PathBuf,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Arc<Self>, ChatGptError> {
        let transport = UreqHttpClient::new()
            .map_err(|_| ChatGptError::new("ChatGPT HTTPS transport is unavailable"))?;
        Ok(Self::with_client(
            codex_home,
            secrets,
            Arc::new(AshClient::new(Arc::new(transport))),
            ChatGptAuthManagement::Automatic,
        ))
    }

    pub fn with_client(
        codex_home: PathBuf,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        management: ChatGptAuthManagement,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            client,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            auth: CodexAuthStore::new(codex_home),
            maintenance: AuthMaintenance::new(management),
        })
    }

    /// Connects asynchronous device-flow completion to the shared login control plane.
    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(login_lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    /// Resolves current credentials, refreshing only when Ash is the credential manager.
    pub fn api_target(&self) -> Result<ChatGptApiTarget, ChatGptError> {
        self.api_target_for(CHATGPT_RESPONSES_BASE_URL)
    }

    /// Returns the ready account identity used to scope its model catalog.
    pub fn account_id(&self) -> Result<Option<String>, ChatGptError> {
        let Some(credential) = self.load_credential()? else {
            return Ok(None);
        };
        if self.account_snapshot(&credential).status != AccountStatus::Ready {
            return Ok(None);
        }
        credential
            .identity()
            .map(|identity| Some(identity.account_id))
    }

    /// Path to the Codex catalog beside the external login when Codex owns the account.
    pub fn codex_model_cache_path(&self) -> Option<PathBuf> {
        self.auth.codex_model_cache_path()
    }

    pub(crate) fn api_target_for(&self, base_url: &str) -> Result<ChatGptApiTarget, ChatGptError> {
        if self.disconnected()? {
            return Err(ChatGptError::new("ChatGPT is disconnected in Ash"));
        }
        let credential = self
            .maintenance
            .resolve(&self.auth, self.client.as_ref(), RefreshReason::Proactive)?
            .ok_or_else(|| ChatGptError::new("ChatGPT is not connected in Ash"))?;
        if !credential.is_usable() {
            return Err(ChatGptError::new(
                "Codex sign-in has expired; update the login in Codex, then reconnect",
            ));
        }
        ChatGptApiTarget::new(base_url, &credential)
    }

    fn disconnected_key() -> SecretKey {
        SecretKey::new(DISCONNECTED_KEY).expect("static connection key is valid")
    }

    fn legacy_disconnected_key() -> SecretKey {
        SecretKey::new(LEGACY_DISCONNECTED_KEY).expect("static legacy connection key is valid")
    }

    fn disconnected(&self) -> Result<bool, ChatGptError> {
        if self
            .secrets
            .load(&Self::disconnected_key())
            .map_err(|_| ChatGptError::new("Ash connection state could not be read"))?
            .is_some()
        {
            return Ok(true);
        }
        let legacy = self
            .secrets
            .load(&Self::legacy_disconnected_key())
            .map_err(|_| ChatGptError::new("Ash connection state could not be read"))?;
        let Some(legacy) = legacy else {
            return Ok(false);
        };
        // Persist the new marker before deleting the old one so a restart cannot
        // silently reconnect a user who had explicitly disconnected Ash.
        self.secrets
            .store(&Self::disconnected_key(), &legacy)
            .and_then(|_| {
                self.secrets
                    .delete(&Self::legacy_disconnected_key())
                    .map(|_| ())
            })
            .map_err(|_| ChatGptError::new("Ash connection state could not be saved"))?;
        Ok(true)
    }

    pub(crate) fn load_credential(&self) -> Result<Option<TokenCredential>, ChatGptError> {
        if self.disconnected()? {
            return Ok(None);
        }
        self.auth.load()
    }

    /// Handles a definite authentication rejection without reusing another account.
    /// The model layer may retry once only when no streamed output was delivered.
    pub fn recover_unauthorized(
        &self,
        rejected: &ChatGptApiTarget,
    ) -> Result<Option<ChatGptApiTarget>, ChatGptError> {
        self.recover_unauthorized_for(rejected, CHATGPT_RESPONSES_BASE_URL)
    }

    pub(crate) fn recover_unauthorized_for(
        &self,
        rejected: &ChatGptApiTarget,
        base_url: &str,
    ) -> Result<Option<ChatGptApiTarget>, ChatGptError> {
        let Some(current) = self.load_credential()? else {
            return Ok(None);
        };
        if current.identity()? != rejected.identity {
            return Err(ChatGptError::new(
                "ChatGPT account changed; the request was not retried",
            ));
        }
        let bearer = rejected
            .target
            .headers
            .iter()
            .find(|header| header.name().eq_ignore_ascii_case("Authorization"))
            .map(|header| header.value());
        let credential = if bearer != Some(format!("Bearer {}", current.access_token).as_str()) {
            current
        } else {
            if !self.maintenance.management.is_ash() {
                return Ok(None);
            }
            self.maintenance
                .resolve(
                    &self.auth,
                    self.client.as_ref(),
                    RefreshReason::Unauthorized {
                        identity: rejected.identity.clone(),
                        revision: current.storage_revision,
                    },
                )?
                .ok_or_else(|| {
                    ChatGptError::new("ChatGPT credentials disappeared during recovery")
                })?
        };
        if credential.identity()? != rejected.identity || !credential.is_usable() {
            return Err(ChatGptError::new(
                "ChatGPT recovery did not produce valid credentials for the same account",
            ));
        }
        if self.disconnected()? {
            return Ok(None);
        }
        ChatGptApiTarget::new(base_url, &credential).map(Some)
    }

    /// Remembers a rejected credential version without deleting shared authentication.
    pub fn note_rejected(&self, rejected: &ChatGptApiTarget) {
        if let Ok(Some(current)) = self.load_credential() {
            if current.storage_revision == rejected.revision {
                self.maintenance.reject(&current);
            }
        }
    }

    fn connect(&self) -> Result<(), ChatGptError> {
        self.secrets
            .delete(&Self::disconnected_key())
            .and_then(|_| self.secrets.delete(&Self::legacy_disconnected_key()))
            .map(|_| ())
            .map_err(|_| ChatGptError::new("Ash connection state could not be saved"))
    }

    fn account_snapshot(&self, credential: &TokenCredential) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: CHATGPT_SUBSCRIPTION_PROVIDER_ID.into(),
                account_id: credential
                    .account_id
                    .clone()
                    .unwrap_or_else(|| "current".into()),
            },
            email: credential.email.clone(),
            display_name: Some("ChatGPT".into()),
            organization: credential.account_id.clone(),
            plan: credential.plan.clone(),
            status: if !self.maintenance.requires_login(credential)
                && credential.identity().is_ok()
                && (credential.is_usable()
                    || self.maintenance.management.is_ash() && credential.refresh_available)
            {
                AccountStatus::Ready
            } else {
                AccountStatus::ReauthenticationRequired
            },
            credential_revision: credential.credential_revision,
        }
    }

    fn finish_login(
        &self,
        login_id: LoginId,
        tokens: Result<TokenResponse, ChatGptError>,
        write: LoginWrite,
    ) {
        // Serialize cancellation with the file commit and completion notification.
        // A cancelled flow must never create auth.json after its UI has reported cancellation.
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(source) = active.remove(&login_id) else {
            return;
        };
        if source.token().is_cancelled() {
            return;
        }
        let outcome = match tokens.and_then(|tokens| {
            if matches!(write, LoginWrite::Replace { .. }) && !self.maintenance.management.is_ash()
            {
                return Err(ChatGptError::new(
                    "Codex now manages authentication; complete sign-in there",
                ));
            }
            self.auth.write_login(&tokens, write)
        }) {
            Ok(credential) => match self.connect() {
                Ok(()) => LoginCompletionOutcome::Succeeded {
                    account: self.account_snapshot(&credential),
                },
                Err(error) => login_failure(error),
            },
            Err(error) => login_failure(error),
        };
        let service = self
            .login_service
            .lock()
            .ok()
            .and_then(|service| service.upgrade());
        if let Some(service) = service {
            let _ = service.complete(CompleteLogin { login_id, outcome });
        }
    }
}

impl InteractiveLoginDriver for ChatGptOAuth {
    fn provider_id(&self) -> &'static str {
        CHATGPT_SUBSCRIPTION_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        self.load_credential()
            .map(|credential| credential.map(|value| self.account_snapshot(&value)))
            .map_err(login_driver_error)
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        if !matches!(
            request.method,
            LoginMethod::OpenAiChatGptBrowser | LoginMethod::OpenAiChatGptDeviceCode
        ) {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "login method is not owned by ChatGPT",
            ));
        }
        let mut active = self.active.lock().map_err(login_lock_error)?;
        if !active.is_empty() {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "a ChatGPT login is already active",
            ));
        }
        let write = if let Some(mut credential) = self.auth.load().map_err(login_driver_error)? {
            let managed = self.maintenance.management.is_ash();
            if managed
                && !self.maintenance.requires_login(&credential)
                && credential.needs_refresh()
            {
                match self.maintenance.resolve(
                    &self.auth,
                    self.client.as_ref(),
                    RefreshReason::Proactive,
                ) {
                    Ok(Some(current)) => credential = current,
                    Ok(None) => {
                        return Err(login_driver_error(ChatGptError::new(
                            "ChatGPT credentials disappeared; retry sign-in",
                        )));
                    }
                    Err(error) if !self.maintenance.requires_login(&credential) => {
                        return Err(login_driver_error(error));
                    }
                    Err(_) => {}
                }
            }
            if credential.is_usable()
                && credential.identity().is_ok()
                && !self.maintenance.requires_login(&credential)
            {
                self.connect().map_err(login_driver_error)?;
                return Ok(BeginLogin::Connected {
                    login_id: request.login_id,
                    account: self.account_snapshot(&credential),
                });
            }
            if !managed {
                return Err(LoginError::new(
                    LoginErrorKind::ExternalLoginRequired,
                    "Codex sign-in has expired; update it in Codex before reconnecting",
                ));
            }
            LoginWrite::Replace {
                revision: credential.storage_revision,
            }
        } else {
            self.auth.ensure_creatable().map_err(login_driver_error)?;
            LoginWrite::Create
        };
        if matches!(write, LoginWrite::Replace { .. }) && !self.maintenance.management.is_ash() {
            return Err(LoginError::new(
                LoginErrorKind::ExternalLoginRequired,
                "Codex now manages authentication; complete sign-in there",
            ));
        }
        let device =
            device_flow::request_device_code(self.client.as_ref()).map_err(login_driver_error)?;
        let cancellation = CancellationSource::new();
        active.insert(request.login_id.clone(), cancellation.clone());
        let weak = self.self_weak.clone();
        let client = Arc::clone(&self.client);
        let login_id = request.login_id.clone();
        let worker_device = device.clone();
        thread::spawn(move || {
            let result = device_flow::complete_device_login(
                client.as_ref(),
                &worker_device,
                &cancellation.token(),
            );
            if let Some(runtime) = weak.upgrade() {
                runtime.finish_login(login_id, result, write);
            }
        });
        Ok(BeginLogin::DeviceCode {
            login_id: request.login_id,
            verification_url: device.verification_url,
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
        if account.provider != CHATGPT_SUBSCRIPTION_PROVIDER_ID {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "account is not owned by the ChatGPT login driver",
            ));
        }
        if self.maintenance.management.is_ash()
            && self.auth.load().map_err(login_driver_error)?.is_some()
        {
            let guard = self.auth.lock_updates().map_err(login_driver_error)?;
            if self.maintenance.management.is_ash() {
                self.auth
                    .logout(&guard, &account.account_id)
                    .map_err(login_driver_error)?;
            }
        }
        self.secrets
            .store(&Self::disconnected_key(), &SecretValue::new(b"1".to_vec()))
            .map_err(|_| {
                LoginError::new(
                    LoginErrorKind::Unavailable,
                    "Ash connection state is unavailable",
                )
            })
    }
}

fn api_headers(credential: &TokenCredential) -> Vec<HttpHeader> {
    let mut headers = vec![
        HttpHeader::new(
            "Authorization",
            format!("Bearer {}", credential.access_token),
        ),
        HttpHeader::new("Originator", "ash"),
        HttpHeader::new("User-Agent", user_agent()),
    ];
    if let Some(account_id) = &credential.account_id {
        headers.push(HttpHeader::new("ChatGPT-Account-ID", account_id));
    }
    if credential.is_fedramp {
        headers.push(HttpHeader::new("X-OpenAI-Fedramp", "true"));
    }
    headers
}

pub(crate) fn user_agent() -> String {
    format!("Ash/{}", env!("CARGO_PKG_VERSION"))
}

fn login_driver_error(error: ChatGptError) -> LoginError {
    LoginError::new(LoginErrorKind::Driver, error.to_string())
}

fn login_lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "ChatGPT login state is unavailable",
    )
}

impl Drop for ChatGptOAuth {
    fn drop(&mut self) {
        if let Ok(active) = self.active.get_mut() {
            for source in active.values() {
                source.cancel();
            }
        }
    }
}

fn login_failure(error: ChatGptError) -> LoginCompletionOutcome {
    LoginCompletionOutcome::Failed {
        failure: LoginFailure {
            code: "chatgpt_login_failed".into(),
            message: error.to_string(),
        },
    }
}
