use crate::ChatGptApiTarget;
use crate::ChatGptOAuth;
use crate::credential::AccountIdentity;
use crate::storage::WebCredentialSource;
use ash_client::OperationClient;
use ash_http_client::HttpHeader;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginId;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::SecretStore;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Profile-scoped Web authentication authority. External and independently
/// issued credentials retain separate stores and explicit source selection.
pub struct ChatGptWebAuthentication {
    codex: Arc<ChatGptOAuth>,
    managed: Arc<ChatGptOAuth>,
}

impl ChatGptWebAuthentication {
    pub fn new(
        profile_root: PathBuf,
        secrets: Arc<dyn SecretStore>,
        client: Arc<dyn OperationClient>,
        codex: Arc<ChatGptOAuth>,
    ) -> Arc<Self> {
        Arc::new(Self {
            codex: codex.web_reuse(),
            managed: ChatGptOAuth::managed_web(profile_root, secrets, client),
        })
    }

    pub fn session(self: &Arc<Self>) -> Result<ChatGptWebAuthSession, ChatGptWebAuthError> {
        ChatGptWebAuthSession::with_authority(Authority::Web(self.clone()))
    }

    /// Each LoginService owns its completion route; all adapters share the same
    /// profile authority rather than overwriting a global callback destination.
    pub fn login_driver(self: &Arc<Self>) -> Arc<ChatGptWebLogin> {
        static NEXT_DRIVER: AtomicU64 = AtomicU64::new(1);
        Arc::new(ChatGptWebLogin {
            scope: NEXT_DRIVER.fetch_add(1, Ordering::Relaxed),
            authority: self.clone(),
            service: Mutex::new(Weak::new()),
        })
    }

    fn selected(&self) -> Result<(Arc<ChatGptOAuth>, u64), ChatGptWebAuthError> {
        let (source, generation) = self
            .managed
            .auth
            .web_source()
            .map_err(|_| ChatGptWebAuthError::Unavailable)?;
        Ok((
            match source {
                WebCredentialSource::Codex => self.codex.clone(),
                WebCredentialSource::Ash => self.managed.clone(),
            },
            generation,
        ))
    }
}

pub struct ChatGptWebLogin {
    scope: u64,
    authority: Arc<ChatGptWebAuthentication>,
    service: Mutex<Weak<LoginService>>,
}

impl ChatGptWebLogin {
    fn scoped_id(&self, id: &LoginId) -> Result<LoginId, LoginError> {
        LoginId::new(format!("web-{}-{}", self.scope, id.as_str()))
    }

    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.service.lock().map_err(|_| login_unavailable())? = Arc::downgrade(service);
        Ok(())
    }
}

impl InteractiveLoginDriver for ChatGptWebLogin {
    fn provider_id(&self) -> &'static str {
        crate::oauth::CHATGPT_WEB_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        let (auth, _) = self.authority.selected().map_err(|_| login_unavailable())?;
        Ok(auth.read_account()?.map(|mut account| {
            account.account.provider = self.provider_id().into();
            account
        }))
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        match request.method {
            LoginMethod::ChatGptWebDeviceCode => {
                let service = self
                    .service
                    .lock()
                    .map_err(|_| login_unavailable())?
                    .clone();
                let completion_id = request.login_id.clone();
                let mut started = self.authority.managed.begin_for_service(
                    BeginLoginRequest {
                        login_id: self.scoped_id(&request.login_id)?,
                        method: request.method,
                    },
                    service,
                    completion_id.clone(),
                )?;
                match &mut started {
                    BeginLogin::Connected { login_id, .. }
                    | BeginLogin::DeviceCode { login_id, .. }
                    | BeginLogin::Browser { login_id, .. } => *login_id = completion_id,
                }
                Ok(started)
            }
            LoginMethod::ChatGptWebCodex => {
                let mut account = self
                    .authority
                    .codex
                    .read_account()?
                    .filter(|account| account.status == ash_login::AccountStatus::Ready)
                    .ok_or_else(|| {
                        LoginError::new(
                            LoginErrorKind::ExternalLoginRequired,
                            "Sign in to Codex before selecting its login",
                        )
                    })?;
                self.authority.managed.use_codex_web_source()?;
                account.account.provider = self.provider_id().into();
                Ok(BeginLogin::Connected {
                    login_id: request.login_id,
                    account,
                })
            }
            _ => Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "Login method is not owned by ChatGPT Web",
            )),
        }
    }

    fn cancel(&self, id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        self.authority.managed.cancel(&self.scoped_id(id)?)
    }

    fn logout_provider(&self, _: &[AccountRef]) -> Result<(), LoginError> {
        self.authority.managed.disconnect_web()
    }

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        if account.provider != self.provider_id() {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "Invalid ChatGPT Web account",
            ));
        }
        // Leaving Web never logs out Codex. Retire its source even when the
        // selected external account has no independent Ash credential to delete.
        let current = self.read_account()?;
        if current.is_some_and(|current| current.account.account_id != account.account_id) {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "ChatGPT Web account changed",
            ));
        }
        self.authority.managed.disconnect_web()
    }
}

fn login_unavailable() -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "ChatGPT Web authentication is unavailable",
    )
}

enum Authority {
    #[cfg(test)]
    Single(Arc<ChatGptOAuth>),
    Web(Arc<ChatGptWebAuthentication>),
}

impl Authority {
    fn selected(&self) -> Result<(Arc<ChatGptOAuth>, u64), ChatGptWebAuthError> {
        match self {
            #[cfg(test)]
            Self::Single(auth) => Ok((auth.clone(), 0)),
            Self::Web(auth) => auth.selected(),
        }
    }
}

const WEB_BASE_URL: &str = "https://chatgpt.com";
const MAX_REQUESTS: usize = 64;

#[derive(Clone, Eq, PartialEq)]
enum Principal {
    Unavailable,
    SignedOut,
    Account {
        provider: &'static str,
        generation: u64,
        identity: AccountIdentity,
    },
}

struct Request {
    target: ChatGptApiTarget,
    authority: Arc<ChatGptOAuth>,
    recovered: bool,
}

/// A private Chromium consumer's request bindings. OAuth remains the credential authority.
/// Only its native host pipe may consume headers; no renderer RPC exposes this type.
pub struct ChatGptWebAuthSession {
    auth: Authority,
    principal: Principal,
    context: String,
    requests: BTreeMap<String, Request>,
}

/// Sanitized failures for a private credential consumer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatGptWebAuthError {
    Unavailable,
    AccountChanged,
    InvalidRequest,
}

impl ChatGptWebAuthSession {
    #[cfg(test)]
    fn new(auth: Arc<ChatGptOAuth>) -> Result<Self, ChatGptWebAuthError> {
        Self::with_authority(Authority::Single(auth))
    }

    fn with_authority(auth: Authority) -> Result<Self, ChatGptWebAuthError> {
        let principal = observe(&auth);
        Ok(Self {
            auth,
            principal,
            context: new_context()?,
            requests: BTreeMap::new(),
        })
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    /// Revokes request bindings when identity or local connection availability changes.
    /// Access-token rotation retains the context and is recovered by the OAuth owner.
    pub fn synchronize(&mut self) -> Result<bool, ChatGptWebAuthError> {
        let principal = observe(&self.auth);
        if principal == self.principal {
            return Ok(false);
        }
        self.context = new_context()?;
        self.principal = principal;
        self.requests.clear();
        Ok(true)
    }

    pub fn authorize(
        &mut self,
        request_id: &str,
        context: &str,
    ) -> Result<Vec<HttpHeader>, ChatGptWebAuthError> {
        if context != self.context {
            return Err(ChatGptWebAuthError::AccountChanged);
        }
        if request_id.is_empty()
            || request_id.len() > 64
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || self.requests.contains_key(request_id)
            || self.requests.len() >= MAX_REQUESTS
        {
            return Err(ChatGptWebAuthError::InvalidRequest);
        }
        let (authority, generation) = self.auth.selected()?;
        let target = authority
            .api_target_for(WEB_BASE_URL)
            .map_err(|_| ChatGptWebAuthError::Unavailable)?;
        self.synchronize()?;
        if context != self.context
            || self.principal
                != (Principal::Account {
                    provider: authority.provider_id(),
                    generation,
                    identity: target.identity.clone(),
                })
        {
            return Err(ChatGptWebAuthError::AccountChanged);
        }
        let headers = target.api_target().headers().to_vec();
        self.requests.insert(
            request_id.into(),
            Request {
                target,
                authority,
                recovered: false,
            },
        );
        Ok(headers)
    }

    /// A definite HTTP 401 can recover once, for the original identity only.
    pub fn recover(
        &mut self,
        request_id: &str,
    ) -> Result<Option<Vec<HttpHeader>>, ChatGptWebAuthError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(ChatGptWebAuthError::AccountChanged)?;
        if request.recovered {
            return Ok(None);
        }
        request.recovered = true;
        let context = self.context.clone();
        let target = request
            .authority
            .recover_unauthorized_for(&request.target, WEB_BASE_URL)
            .map_err(|_| ChatGptWebAuthError::Unavailable)?;
        self.synchronize()?;
        if context != self.context {
            return Err(ChatGptWebAuthError::AccountChanged);
        }
        let Some(target) = target else {
            return Ok(None);
        };
        let headers = target.api_target().headers().to_vec();
        self.requests
            .get_mut(request_id)
            .ok_or(ChatGptWebAuthError::AccountChanged)?
            .target = target;
        Ok(Some(headers))
    }

    pub fn release(&mut self, request_id: &str) {
        self.requests.remove(request_id);
    }
}

fn observe(authority: &Authority) -> Principal {
    let Ok((auth, generation)) = authority.selected() else {
        return Principal::Unavailable;
    };
    match auth.load_credential() {
        Ok(Some(credential)) => credential
            .identity()
            .map(|identity| Principal::Account {
                provider: auth.provider_id(),
                generation,
                identity,
            })
            .unwrap_or(Principal::Unavailable),
        Ok(None) => Principal::SignedOut,
        Err(_) => Principal::Unavailable,
    }
}

fn new_context() -> Result<String, ChatGptWebAuthError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| ChatGptWebAuthError::Unavailable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
#[path = "web_auth_tests.rs"]
mod tests;
