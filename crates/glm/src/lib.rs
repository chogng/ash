//! Account login and model credentials for GLM Coding Plan and Start Plan subscriptions.

#[path = "zcode.rs"]
mod zcode;

use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::AshClient;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
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
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use url::Url;
use zeroize::Zeroize;

pub use backend_client::QuotaLimit;

pub const BIGMODEL_PROVIDER_ID: &str = "bigmodel-coding-plan";
pub const ZAI_PROVIDER_ID: &str = "zai-coding-plan";
pub const BIGMODEL_START_PLAN_PROVIDER_ID: &str = "bigmodel-start-plan";
pub const ZAI_START_PLAN_PROVIDER_ID: &str = "zai-start-plan";
/// Eligible model buckets from the current account's Start Plan, including exhausted buckets.
#[derive(Clone, Debug)]
pub struct StartPlanUsage {
    pub plans: Vec<String>,
    pub limits: Vec<StartPlanLimit>,
}

#[derive(Clone, Debug)]
pub struct StartPlanLimit {
    pub id: String,
    pub name: String,
    pub models: Vec<String>,
    pub total_units: u64,
    pub used_units: u64,
    pub available_units: u64,
    pub period_start: u64,
    pub period_end: u64,
}

impl StartPlanUsage {
    pub fn models(&self) -> std::collections::BTreeSet<String> {
        self.limits
            .iter()
            .flat_map(|limit| limit.models.iter().cloned())
            .collect()
    }
}

const OAUTH_BASE_URL: &str = "https://zcode.z.ai/api/v1/oauth/cli";

/// The account and its request key come from one credential read.
pub struct GlmApiTarget {
    pub account_id: String,
    pub target: ResolvedApiTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlmUsageError {
    Unavailable,
    AccountChanged,
    AuthenticationRequired,
    Cancelled,
    RequestFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlmProvider {
    BigModel,
    Zai,
    BigModelStartPlan,
    ZaiStartPlan,
}

impl GlmProvider {
    fn oauth_id(self) -> &'static str {
        match self {
            Self::BigModel | Self::BigModelStartPlan => "bigmodel",
            Self::Zai | Self::ZaiStartPlan => "zai",
        }
    }

    fn provider_id(self) -> &'static str {
        match self {
            Self::BigModel => BIGMODEL_PROVIDER_ID,
            Self::Zai => ZAI_PROVIDER_ID,
            Self::BigModelStartPlan => BIGMODEL_START_PLAN_PROVIDER_ID,
            Self::ZaiStartPlan => ZAI_START_PLAN_PROVIDER_ID,
        }
    }

    fn model_url(self) -> &'static str {
        match self {
            Self::BigModel => "https://open.bigmodel.cn/api/coding/paas/v4",
            Self::Zai => "https://api.z.ai/api/coding/paas/v4",
            Self::BigModelStartPlan | Self::ZaiStartPlan => backend_client::start_plan::MODEL_URL,
        }
    }

    fn login_method(self) -> LoginMethod {
        match self {
            Self::BigModel => LoginMethod::BigModelBrowser,
            Self::Zai => LoginMethod::ZaiBrowser,
            Self::BigModelStartPlan => LoginMethod::BigModelStartPlanBrowser,
            Self::ZaiStartPlan => LoginMethod::ZaiStartPlanBrowser,
        }
    }

    fn is_start_plan(self) -> bool {
        matches!(self, Self::BigModelStartPlan | Self::ZaiStartPlan)
    }

    fn credential_key(self) -> SecretKey {
        let owner = if self.is_start_plan() {
            self.provider_id()
        } else {
            self.oauth_id()
        };
        SecretKey::new(format!("provider/{owner}/current/oauth"))
            .expect("static GLM provider has a valid credential key")
    }

    fn disconnected_key(self) -> SecretKey {
        SecretKey::new(format!("provider/{}/disconnected", self.provider_id()))
            .expect("static GLM connection has a valid secret key")
    }
}

/// Owns one subscription connection and its private model request credential.
pub struct GlmOAuth {
    provider: GlmProvider,
    client: Arc<dyn OperationClient>,
    secrets: Arc<dyn SecretStore>,
    self_weak: Weak<Self>,
    login_service: Mutex<Weak<LoginService>>,
    active: Mutex<BTreeMap<LoginId, CancellationSource>>,
    zcode: Option<zcode::ZCodeCredentials>,
    device_id: Mutex<Option<String>>,
}

impl GlmOAuth {
    pub fn production(
        provider: GlmProvider,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Arc<Self>, LoginError> {
        let transport = UreqHttpClient::new().map_err(|_| unavailable())?;
        Self::with_zcode_credentials(
            provider,
            secrets,
            Arc::new(AshClient::new(Arc::new(transport))),
        )
    }

    pub fn with_zcode_credentials(
        provider: GlmProvider,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
    ) -> Result<Arc<Self>, LoginError> {
        let zcode = zcode::ZCodeCredentials::from_environment()?;
        Ok(Self::with_client_and_zcode(
            provider,
            secrets,
            client,
            Some(zcode),
        ))
    }

    pub fn with_client(
        provider: GlmProvider,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
    ) -> Arc<Self> {
        Self::with_client_and_zcode(provider, secrets, client, None)
    }

    fn with_client_and_zcode(
        provider: GlmProvider,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        zcode: Option<zcode::ZCodeCredentials>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            provider,
            client,
            secrets,
            self_weak: self_weak.clone(),
            login_service: Mutex::new(Weak::new()),
            active: Mutex::new(BTreeMap::new()),
            zcode,
            device_id: Mutex::new(None),
        })
    }

    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.login_service.lock().map_err(|_| unavailable())? = Arc::downgrade(service);
        Ok(())
    }

    pub fn connection_id(&self) -> &'static str {
        self.provider.provider_id()
    }

    pub fn is_start_plan(&self) -> bool {
        self.provider.is_start_plan()
    }

    /// Reads the login-owned credential for one subscription invocation.
    pub fn api_target(&self) -> Result<GlmApiTarget, LoginError> {
        let credential = self.load()?.ok_or_else(unavailable)?;
        self.target_for(&credential, ash_client::RequestPurpose::Model)
    }

    pub fn input_token_count_target(&self) -> Result<GlmApiTarget, LoginError> {
        let credential = self.load()?.ok_or_else(unavailable)?;
        self.target_for(&credential, ash_client::RequestPurpose::InputTokenCount)
    }

    fn identity(&self, credential: &Credential) -> ash_client::RequestIdentity {
        ash_client::RequestIdentity::account(
            self.connection_id(),
            &credential.account_id,
            credential.revision,
        )
    }

    fn target_for(
        &self,
        credential: &Credential,
        purpose: ash_client::RequestPurpose,
    ) -> Result<GlmApiTarget, LoginError> {
        Ok(GlmApiTarget {
            account_id: credential.account_id.clone(),
            target: ResolvedApiTarget::new(
                self.provider.model_url(),
                self.request_headers(credential)?,
                ash_client::RequestBinding::new(purpose, self.identity(credential)),
            ),
        })
    }

    /// Balance, policy and generation use one snapshot. Re-reading after preflight
    /// would allow an unchecked credential to replace the identity we just checked.
    pub fn model_api_target(
        &self,
        model: &str,
        cancellation: &CancellationToken,
    ) -> Result<GlmApiTarget, LoginError> {
        let credential = self.load()?.ok_or_else(unavailable)?;
        if self.is_start_plan() {
            let usage = self
                .start_plan_for(&credential, cancellation)
                .map_err(|_| unavailable())?;
            if !usage.models().contains(&model.to_ascii_lowercase()) {
                return Err(LoginError::new(
                    LoginErrorKind::Unavailable,
                    "model is not included in this Start Plan",
                ));
            }
            let target = self.business_target(&credential)?;
            if !backend_client::start_plan::model_request_allowed(
                self.client.as_ref(),
                &target,
                cancellation,
            )
            .map_err(|_| unavailable())?
            {
                return Err(LoginError::new(
                    LoginErrorKind::ExternalLoginRequired,
                    "Start Plan requires verification in ZCode",
                ));
            }
        }
        cancellation.check().map_err(|_| unavailable())?;
        self.ensure_current(&credential)
            .map_err(|_| unavailable())?;
        self.target_for(&credential, ash_client::RequestPurpose::Model)
    }

    fn business_target(&self, credential: &Credential) -> Result<ResolvedApiTarget, LoginError> {
        Ok(ResolvedApiTarget::new(
            backend_client::start_plan::SERVICE_URL,
            self.request_headers(credential)?,
            ash_client::RequestBinding::new(
                ash_client::RequestPurpose::Account,
                self.identity(credential),
            ),
        ))
    }

    fn request_headers(&self, credential: &Credential) -> Result<Vec<HttpHeader>, LoginError> {
        let mut headers = vec![HttpHeader::new(
            "Authorization",
            format!("Bearer {}", credential.model_key),
        )];
        if self.is_start_plan() {
            let mut device_id = self.device_id.lock().map_err(|_| unavailable())?;
            if device_id.is_none() {
                let key = SecretKey::new(format!("provider/{}/device-id", self.connection_id()))
                    .expect("valid device key");
                *device_id = Some(match self.secrets.load(&key).map_err(|_| unavailable())? {
                    Some(value) => {
                        String::from_utf8(value.expose().to_vec()).map_err(|_| unavailable())?
                    }
                    None => {
                        let id = random_device_id()?;
                        self.secrets
                            .store(&key, &SecretValue::new(id.as_bytes().to_vec()))
                            .map_err(|_| unavailable())?;
                        id
                    }
                });
            }
            headers.extend([
                HttpHeader::new("User-Agent", concat!("Ash/", env!("CARGO_PKG_VERSION"))),
                HttpHeader::new("X-Title", "Ash"),
                HttpHeader::new(
                    "X-Device-Mid",
                    device_id.as_deref().expect("device identity initialized"),
                ),
            ]);
        }
        Ok(headers)
    }

    pub fn read_start_plan(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<StartPlanUsage, GlmUsageError> {
        if !self.is_start_plan() {
            return Err(GlmUsageError::Unavailable);
        }
        let credential = self
            .load()
            .map_err(|_| GlmUsageError::Unavailable)?
            .ok_or(GlmUsageError::AuthenticationRequired)?;
        if credential.account_id != account_id {
            return Err(GlmUsageError::AccountChanged);
        }
        self.start_plan_for(&credential, cancellation)
    }

    fn start_plan_for(
        &self,
        credential: &Credential,
        cancellation: &CancellationToken,
    ) -> Result<StartPlanUsage, GlmUsageError> {
        let target = self
            .business_target(credential)
            .map_err(|_| GlmUsageError::Unavailable)?;
        let balance =
            backend_client::start_plan::read_balance(self.client.as_ref(), &target, cancellation)
                .map_err(usage_error)?;
        cancellation.check().map_err(|_| GlmUsageError::Cancelled)?;
        self.ensure_current(credential)?;
        Ok(start_plan_usage(balance))
    }

    fn ensure_current(&self, credential: &Credential) -> Result<(), GlmUsageError> {
        let current = self
            .load()
            .map_err(|_| GlmUsageError::Unavailable)?
            .ok_or(GlmUsageError::AccountChanged)?;
        if current.account_id != credential.account_id || current.revision != credential.revision {
            return Err(GlmUsageError::AccountChanged);
        }
        Ok(())
    }

    pub fn account_id(&self) -> Result<Option<String>, LoginError> {
        Ok(self.load()?.map(|credential| credential.account_id.clone()))
    }

    /// Queries the account bound to the current request key, then checks that the
    /// credential is still current before publishing its result.
    pub fn read_usage(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<QuotaLimit>, GlmUsageError> {
        let credential = self
            .load()
            .map_err(|_| GlmUsageError::Unavailable)?
            .ok_or(GlmUsageError::AuthenticationRequired)?;
        if credential.account_id != account_id {
            return Err(GlmUsageError::AccountChanged);
        }
        let quota_url = match self.provider {
            GlmProvider::BigModel => backend_client::bigmodel::MONITOR_URL,
            GlmProvider::Zai => backend_client::zai::BUSINESS_URL,
            GlmProvider::BigModelStartPlan | GlmProvider::ZaiStartPlan => {
                return Err(GlmUsageError::Unavailable);
            }
        };
        let target = ResolvedApiTarget::new(
            quota_url,
            vec![HttpHeader::new("Authorization", &credential.model_key)],
            ash_client::RequestBinding::new(
                ash_client::RequestPurpose::Account,
                self.identity(&credential),
            ),
        );
        let limits = match self.provider {
            GlmProvider::BigModel => {
                backend_client::bigmodel::read_quota(self.client.as_ref(), &target, cancellation)
            }
            GlmProvider::BigModelStartPlan | GlmProvider::ZaiStartPlan => {
                return Err(GlmUsageError::Unavailable);
            }
            GlmProvider::Zai => {
                backend_client::zai::read_quota(self.client.as_ref(), &target, cancellation)
            }
        }
        .map_err(usage_error)?;
        cancellation.check().map_err(|_| GlmUsageError::Cancelled)?;
        self.ensure_current(&credential)?;
        Ok(limits)
    }

    fn load(&self) -> Result<Option<Credential>, LoginError> {
        // Disconnect belongs to this Ash connection, not the external account.
        // Check it before either credential source so refresh cannot reconnect it.
        if self
            .secrets
            .load(&self.provider.disconnected_key())
            .map_err(|_| unavailable())?
            .is_some()
        {
            return Ok(None);
        }
        if let Some(zcode) = &self.zcode
            && let Some(credential) = zcode.reusable_credential(self.provider)
        {
            return Ok(Some(credential));
        }
        self.load_internal()
    }

    fn load_internal(&self) -> Result<Option<Credential>, LoginError> {
        self.secrets
            .load(&self.provider.credential_key())
            .map_err(|_| unavailable())?
            .map(|stored| serde_json::from_slice(stored.expose()).map_err(|_| unavailable()))
            .transpose()
    }

    fn store(&self, credential: &Credential) -> Result<(), LoginError> {
        let encoded = serde_json::to_vec(credential).map_err(|_| unavailable())?;
        self.secrets
            .store(&self.provider.credential_key(), &SecretValue::new(encoded))
            .map_err(|_| unavailable())
    }

    fn snapshot(&self, credential: &Credential) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: self.provider.provider_id().into(),
                account_id: credential.account_id.clone(),
            },
            email: credential.email.clone(),
            display_name: credential.display_name.clone(),
            organization: None,
            plan: None,
            status: AccountStatus::Ready,
            credential_revision: credential.revision,
        }
    }

    fn init(&self, poll_token: &str) -> Result<InitData, LoginError> {
        let response = self.request(
            HttpMethod::Post,
            format!("{OAUTH_BASE_URL}/init"),
            poll_token,
            serde_json::to_vec(&serde_json::json!({"provider": self.provider.oauth_id()}))
                .map_err(|_| unavailable())?,
            &CancellationSource::new().token(),
        )?;
        let data: InitData = decode(response)?;
        if !Url::parse(&data.authorize_url)
            .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
            || data.flow_id.trim().is_empty()
            || data.poll_interval_sec == 0
            || data.expires_at <= now_seconds()
        {
            return Err(unavailable());
        }
        Ok(data)
    }

    fn poll(
        &self,
        init: &InitData,
        poll_token: &str,
        cancel: &CancellationToken,
    ) -> Result<Credential, LoginError> {
        let deadline = init.expires_at;
        while now_seconds() < deadline {
            let remaining = deadline.saturating_sub(now_seconds());
            wait(
                Duration::from_secs(init.poll_interval_sec.min(remaining)),
                cancel,
            )?;
            if now_seconds() >= deadline {
                break;
            }
            let mut url = Url::parse(OAUTH_BASE_URL).expect("static OAuth URL is valid");
            url.path_segments_mut()
                .expect("static OAuth URL accepts path segments")
                .extend(["poll", init.flow_id.as_str()]);
            let response = self.request(
                HttpMethod::Get,
                url.to_string(),
                poll_token,
                Vec::new(),
                cancel,
            )?;
            let status: PollData = decode(response)?;
            match status.status.as_str() {
                "pending" => continue,
                "failed" => return Err(unavailable()),
                "ready" => {
                    let user = status.user.ok_or_else(unavailable)?;
                    if user.user_id.trim().is_empty() {
                        return Err(unavailable());
                    }
                    let model_key = if self.is_start_plan() {
                        let jwt = status
                            .token
                            .filter(|token| !token.trim().is_empty())
                            .ok_or_else(unavailable)?;
                        if zcode::jwt_subject(&jwt).as_deref() != Some(user.user_id.as_str()) {
                            return Err(unavailable());
                        }
                        jwt
                    } else {
                        let token = match self.provider {
                            GlmProvider::BigModel => status.bigmodel,
                            GlmProvider::Zai => status.zai,
                            GlmProvider::BigModelStartPlan | GlmProvider::ZaiStartPlan => {
                                unreachable!("handled above")
                            }
                        }
                        .and_then(|token| token.access_token.or(token.alternate_access_token))
                        .filter(|token| !token.trim().is_empty())
                        .ok_or_else(unavailable)?;
                        match self.provider {
                            GlmProvider::BigModel => backend_client::bigmodel::issue_api_key(
                                self.client.as_ref(),
                                &ResolvedApiTarget::new(
                                    backend_client::bigmodel::BUSINESS_URL,
                                    vec![HttpHeader::new("Authorization", &token)],
                                    ash_client::RequestBinding::new(
                                        ash_client::RequestPurpose::Account,
                                        ash_client::RequestIdentity::connection(
                                            self.connection_id(),
                                            token.as_bytes(),
                                        ),
                                    ),
                                ),
                                cancel,
                            ),
                            GlmProvider::Zai => backend_client::zai::issue_api_key(
                                self.client.as_ref(),
                                &token,
                                cancel,
                            ),
                            GlmProvider::BigModelStartPlan | GlmProvider::ZaiStartPlan => {
                                unreachable!("handled above")
                            }
                        }
                        .map_err(|_| unavailable())?
                    };
                    cancel.check().map_err(|_| unavailable())?;
                    return Ok(Credential {
                        account_id: user.user_id,
                        email: user.email,
                        display_name: user.name,
                        model_key,
                        revision: self
                            .load()?
                            .map_or(1, |current| current.revision.saturating_add(1)),
                    });
                }
                _ => return Err(unavailable()),
            }
        }
        Err(unavailable())
    }

    fn request(
        &self,
        method: HttpMethod,
        url: String,
        poll_token: &str,
        body: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<ash_client::ClientResponse, LoginError> {
        let request = ClientRequest::new(
            method,
            url,
            vec![
                HttpHeader::new("Authorization", format!("Bearer {poll_token}")),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            body,
            RetryPolicy::never(),
        )
        .map_err(|_| unavailable())?
        .without_redirects();
        let response = self
            .client
            .execute_with_cancellation(&request, cancel)
            .map_err(|_| unavailable())?;
        if !response.is_success() {
            return Err(unavailable());
        }
        Ok(response)
    }

    fn complete(&self, login_id: LoginId, result: Result<Credential, LoginError>) {
        let mut active = self.active.lock().expect("GLM login state is available");
        let Some(source) = active.get(&login_id) else {
            return;
        };
        if source.token().is_cancelled() {
            return;
        }
        // Keep completion and credential persistence in the same login-state transition.
        // A concurrent cancel cannot report success after a credential was saved.
        let outcome = match result {
            Ok(credential) => match self.store(&credential) {
                Ok(()) => LoginCompletionOutcome::Succeeded {
                    account: self.snapshot(&credential),
                },
                Err(_) => LoginCompletionOutcome::Failed {
                    failure: login_failure(),
                },
            },
            Err(_) => LoginCompletionOutcome::Failed {
                failure: login_failure(),
            },
        };
        if let Some(service) = self
            .login_service
            .lock()
            .expect("GLM login service is available")
            .upgrade()
        {
            let _ = service.complete(CompleteLogin {
                login_id: login_id.clone(),
                outcome,
            });
        }
        active.remove(&login_id);
    }
}

impl InteractiveLoginDriver for GlmOAuth {
    fn provider_id(&self) -> &'static str {
        self.provider.provider_id()
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self.load()?.map(|credential| self.snapshot(&credential)))
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        if request.method != self.provider.login_method() {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "wrong GLM login method",
            ));
        }
        if !self.active.lock().map_err(|_| unavailable())?.is_empty() {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "GLM login is already active",
            ));
        }
        if let Some(source) = &self.zcode
            && let Some(credential) = source.reusable_credential(self.provider)
        {
            self.secrets
                .delete(&self.provider.disconnected_key())
                .map_err(|_| unavailable())?;
            return Ok(BeginLogin::Connected {
                login_id: request.login_id,
                account: self.snapshot(&credential),
            });
        }
        let poll_token = random_token()?;
        let init = self.init(&poll_token)?;
        self.secrets
            .delete(&self.provider.disconnected_key())
            .map_err(|_| unavailable())?;
        let cancellation = CancellationSource::new();
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        if !active.is_empty() {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "GLM login is already active",
            ));
        }
        active.insert(request.login_id.clone(), cancellation.clone());
        drop(active);
        let weak = self.self_weak.clone();
        let login_id = request.login_id.clone();
        let authorization_url = init.authorize_url.clone();
        thread::spawn(move || {
            let Some(owner) = weak.upgrade() else {
                return;
            };
            let result = owner.poll(&init, &poll_token, &cancellation.token());
            owner.complete(login_id, result);
        });
        Ok(BeginLogin::Browser {
            login_id: request.login_id,
            authorization_url,
        })
    }

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let source = self
            .active
            .lock()
            .map_err(|_| unavailable())?
            .remove(login_id);
        let Some(source) = source else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        source.cancel();
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        if account.provider != self.provider.provider_id() {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "wrong GLM account provider",
            ));
        }
        let current = self.load()?.ok_or_else(unavailable)?;
        if current.account_id != account.account_id {
            return Err(LoginError::new(
                LoginErrorKind::Conflict,
                "GLM account changed",
            ));
        }
        // ZCode is read-only. Persist a local disconnect before deleting any Ash
        // credential, including one hidden behind the currently reused account.
        self.secrets
            .store(
                &self.provider.disconnected_key(),
                &SecretValue::new(b"1".to_vec()),
            )
            .map_err(|_| unavailable())?;
        self.secrets
            .delete(&self.provider.credential_key())
            .map(|_| ())
            .map_err(|_| unavailable())
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    code: i64,
    data: Option<T>,
}

#[derive(Clone, Deserialize)]
struct InitData {
    authorize_url: String,
    expires_at: u64,
    flow_id: String,
    poll_interval_sec: u64,
}

#[derive(Deserialize)]
struct PollData {
    status: String,
    token: Option<String>,
    user: Option<User>,
    bigmodel: Option<ProviderToken>,
    zai: Option<ProviderToken>,
}

#[derive(Deserialize)]
struct User {
    user_id: String,
    email: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct ProviderToken {
    access_token: Option<String>,
    #[serde(rename = "accessToken")]
    alternate_access_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Credential {
    account_id: String,
    email: Option<String>,
    display_name: Option<String>,
    model_key: String,
    revision: u64,
}

impl Drop for Credential {
    fn drop(&mut self) {
        self.model_key.zeroize();
    }
}

fn decode<T: for<'de> Deserialize<'de>>(
    response: ash_client::ClientResponse,
) -> Result<T, LoginError> {
    let envelope: Envelope<T> =
        serde_json::from_slice(response.body()).map_err(|_| unavailable())?;
    if envelope.code != 0 {
        return Err(unavailable());
    }
    envelope.data.ok_or_else(unavailable)
}

fn random_token() -> Result<String, LoginError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| unavailable())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after Unix epoch")
        .as_secs()
}

fn wait(duration: Duration, cancel: &CancellationToken) -> Result<(), LoginError> {
    let mut remaining = duration;
    while !remaining.is_zero() {
        cancel.check().map_err(|_| unavailable())?;
        let slice = remaining.min(Duration::from_millis(100));
        thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    cancel.check().map_err(|_| unavailable())
}

fn unavailable() -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "GLM subscription login is unavailable",
    )
}

fn login_failure() -> LoginFailure {
    LoginFailure {
        code: "glm_login_failed".into(),
        message: "GLM subscription login failed".into(),
    }
}

#[cfg(test)]
#[path = "glm_tests.rs"]
mod tests;

/// Sign-in service used by this provider, for connection diagnostics and domain lists.
pub fn sign_in_endpoint() -> &'static str {
    OAUTH_BASE_URL
}

/// Usage service selected by the Coding Plan account owner.
pub fn usage_endpoint(provider: GlmProvider) -> &'static str {
    match provider {
        GlmProvider::BigModel => backend_client::bigmodel::BUSINESS_URL,
        GlmProvider::Zai => backend_client::zai::BUSINESS_URL,
        GlmProvider::BigModelStartPlan | GlmProvider::ZaiStartPlan => {
            backend_client::start_plan::SERVICE_URL
        }
    }
}

fn usage_error(error: backend_client::RequestError) -> GlmUsageError {
    match error {
        backend_client::RequestError::Cancelled => GlmUsageError::Cancelled,
        backend_client::RequestError::HttpStatus(401 | 403) => {
            GlmUsageError::AuthenticationRequired
        }
        _ => GlmUsageError::RequestFailed,
    }
}

fn random_device_id() -> Result<String, LoginError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| unavailable())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn start_plan_usage(balance: backend_client::start_plan::Balance) -> StartPlanUsage {
    let active: BTreeMap<_, _> = balance
        .plans
        .iter()
        .filter(|plan| {
            plan.status == "active"
                && plan.starts_at <= balance.server_time
                && plan.ends_at > balance.server_time
        })
        .map(|plan| (plan.user_plan_id.as_str(), plan.name.clone()))
        .collect();
    let limits = balance
        .balances
        .into_iter()
        .filter(|bucket| {
            active.contains_key(bucket.user_plan_id.as_str())
                && bucket.period_start <= balance.server_time
                && bucket.period_end > balance.server_time
                && bucket.expires_at > balance.server_time
        })
        .map(|bucket| StartPlanLimit {
            id: bucket.bucket_id,
            name: bucket.show_name,
            models: bucket
                .capabilities
                .iter()
                .filter_map(|capability| capability.strip_prefix("model:"))
                .filter(|model| !model.trim().is_empty())
                .map(|model| model.trim().to_ascii_lowercase())
                .collect(),
            total_units: bucket.total_units,
            used_units: bucket.used_units,
            available_units: bucket.available_units,
            period_start: bucket.period_start,
            period_end: bucket.period_end,
        })
        .collect();
    StartPlanUsage {
        plans: active.into_values().collect(),
        limits,
    }
}
