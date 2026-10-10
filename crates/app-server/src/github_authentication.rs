//! Profile composition for the independently supervised GitHub authentication provider.
//! Only backend consumer traits cross this boundary; credential state stays in the child.

use ash_async_utils::CancellationToken;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::ExtensionActivationSpec;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::ProcessIsolationPolicy;
use ash_external_ext::ProductExecutableLauncher;
use ash_external_ext::RestartPolicy;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_login::AccountMultiplicity;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginId;
use ash_login::LoginService;
use ash_login::extension::AuthenticationRequest;
use ash_login::extension::AuthenticationResponse;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use external_ext_protocol::ActivateParams;
use external_ext_protocol::ExtensionCapability;
use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::HostErrorCode;
use external_ext_protocol::HostFailure;
use external_ext_protocol::PackageBinding;
use external_ext_protocol::services::CoreHttpMethod;
use external_ext_protocol::services::CoreServiceRequest;
use external_ext_protocol::services::CoreServiceResponse;
use github::GitHubAccount;
use github::GitHubAccountManager;
use github::GitHubAuthenticationRequest;
use github::GitHubAuthenticationResponse;
use github::GitHubAuthorization;
use github::GitHubBrowserConfig;
use github::GitHubCredentialProvider;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const EXTENSION_ID: &str = "ash.github-authentication";
const CHANNEL_ID: &str = "authentication.github";

struct ProductAuthority;
impl ActivationLease for ProductAuthority {}
impl ActivationAuthority for ProductAuthority {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        Some(Box::new(Self))
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AttemptState {
    Active,
    Cancelled,
    LoggedOut,
}

/// One runtime per profile, shared by every directory and App window.
pub(crate) struct GitHubAuthenticationRuntime {
    executable: PathBuf,
    configurations: Vec<GitHubBrowserConfig>,
    supervisor: ExtensionHostSupervisor,
    allowed_http: Arc<Mutex<BTreeSet<String>>>,
    http: Arc<dyn HttpClient>,
    secrets: Arc<dyn SecretStore>,
    subscribers: Mutex<Vec<Weak<LoginService>>>,
    next_login: AtomicU64,
    attempts: Arc<Mutex<BTreeMap<LoginId, AttemptState>>>,
}

impl GitHubAuthenticationRuntime {
    pub(crate) fn open(
        executable: PathBuf,
        configurations: Vec<GitHubBrowserConfig>,
        http: Arc<dyn HttpClient>,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Arc<Self>, LoginError> {
        let executable = std::fs::canonicalize(executable).map_err(|_| unavailable())?;
        let launcher = Arc::new(
            ProductExecutableLauncher::new(executable.clone()).map_err(|_| unavailable())?,
        );
        let command = ExtensionLaunchCommand::new(
            executable.clone(),
            std::iter::empty::<String>(),
            executable.parent().ok_or_else(unavailable)?,
            BTreeMap::new(),
        )
        .map_err(|_| unavailable())?
        .with_extension_environment(BTreeMap::from([(
            "ASH_GITHUB_BROWSER_CONFIG".into(),
            Some(serde_json::to_string(&configurations).map_err(|_| unavailable())?),
        )]))
        .map_err(|_| unavailable())?;
        let binding = PackageBinding {
            package_id: EXTENSION_ID.into(),
            // Product executables are admitted by their installation, never by a profile manifest.
            package_digest: executable_digest(&executable).map_err(|_| unavailable())?,
            entrypoint: "ash-github-authentication".into(),
        };
        let activation = ExtensionActivationSpec::new(
            ActivateParams {
                initialization: None,
                extension_id: EXTENSION_ID.into(),
                package: binding,
                runtime_api_version: 1,
                activation_events: vec!["onAuthentication:github".into()],
                capabilities: vec![ExtensionCapability::DataChannel],
            },
            NonZeroU64::new(1).expect("activation generation"),
            Arc::new(ProductAuthority),
        );
        let supervisor = ExtensionHostSupervisor::new(
            launcher,
            command,
            activation,
            ExtensionHostLimits {
                isolation: ProcessIsolationPolicy::AuthorizedProduct,
                ..ExtensionHostLimits::default()
            },
            RestartPolicy::default(),
        )
        .map_err(|_| unavailable())?;
        let mut urls = BTreeSet::from(["https://api.github.com/user".into()]);
        for config in &configurations {
            urls.insert(format!("https://{}/api/v3/user", config.host));
            urls.insert(
                config
                    .broker_base_url
                    .join("v1/oauth/github/token")
                    .map_err(|_| unavailable())?
                    .to_string(),
            );
        }
        let allowed_http = Arc::new(Mutex::new(urls));
        let allowed = allowed_http.clone();
        let background_http = http.clone();
        let background_secrets = secrets.clone();
        supervisor
            .start_with_client(
                None,
                Some(Arc::new(move |_, operation, cancellation, _| {
                    let ExtensionClientOperation::CoreService { request } = operation else {
                        return Err(denied());
                    };
                    let response = service(
                        request,
                        &allowed,
                        background_http.as_ref(),
                        background_secrets.as_ref(),
                        cancellation,
                    )?;
                    Ok(ExtensionClientResult::CoreService { response })
                })),
            )
            .map_err(|_| unavailable())?;
        Ok(Arc::new(Self {
            executable,
            configurations,
            supervisor,
            allowed_http,
            http,
            secrets,
            subscribers: Mutex::new(Vec::new()),
            next_login: AtomicU64::new(1),
            attempts: Arc::new(Mutex::new(BTreeMap::new())),
        }))
    }
    pub(crate) fn matches(
        &self,
        executable: &Path,
        configurations: &[GitHubBrowserConfig],
    ) -> bool {
        std::fs::canonicalize(executable).is_ok_and(|path| path == self.executable)
            && configurations == self.configurations
    }
    fn call(
        &self,
        request: GitHubAuthenticationRequest,
        cancellation: Option<&CancellationToken>,
    ) -> Result<GitHubAuthenticationResponse, LoginError> {
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unavailable())?
            .as_millis() as u64
            + 30_000;
        let handle = self
            .supervisor
            .begin_invoke(ExtensionInvocation {
                registration_id: CHANNEL_ID.into(),
                operation: "receiveData".into(),
                payload: serde_json::to_value(request).map_err(|_| unavailable())?,
                deadline_unix_millis: NonZeroU64::new(deadline).ok_or_else(unavailable)?,
            })
            .map_err(|_| unavailable())?;
        // The external token is checked while waiting, so cancelled account connection work
        // cannot be accepted as a successful frontend operation.
        let output = if let Some(cancellation) = cancellation {
            let completed = std::sync::atomic::AtomicBool::new(false);
            std::thread::scope(|scope| {
                let completed_ref = &completed;
                let handle_ref = &handle;
                scope.spawn(move || {
                    while !completed_ref.load(Ordering::Acquire) {
                        if cancellation.is_cancelled() {
                            let _ = handle_ref.cancel(external_ext_protocol::CancelReason::Caller);
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                });
                let output = self.wait(&handle);
                completed.store(true, Ordering::Release);
                output
            })
        } else {
            self.wait(&handle)
        }
        .map_err(|_| unavailable())?;
        serde_json::from_value::<Result<GitHubAuthenticationResponse, LoginError>>(output.payload)
            .map_err(|_| unavailable())?
    }
    fn wait(
        &self,
        handle: &ash_external_ext::ExtensionInvocationHandle,
    ) -> Result<external_ext_protocol::InvokeResult, ash_external_ext::ExtensionHostError> {
        handle.wait_with_client(|operation, cancellation, _| {
            let ExtensionClientOperation::CoreService { request } = operation else {
                return Err(denied());
            };
            let response = service(
                request,
                &self.allowed_http,
                self.http.as_ref(),
                self.secrets.as_ref(),
                cancellation,
            )?;
            Ok(ExtensionClientResult::CoreService { response })
        })
    }
    fn authentication(
        &self,
        request: AuthenticationRequest,
    ) -> Result<AuthenticationResponse, LoginError> {
        if let GitHubAuthenticationResponse::Authentication(response) =
            self.call(GitHubAuthenticationRequest::Authentication(request), None)?
        {
            Ok(response)
        } else {
            Err(unavailable())
        }
    }
    fn publish_accounts(&self) {
        let subscribers = {
            let mut subscribers = self
                .subscribers
                .lock()
                .expect("authentication subscribers lock");
            subscribers.retain(|service| service.strong_count() > 0);
            subscribers
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for service in subscribers {
            let _ = service.refresh();
        }
    }
}
impl Drop for GitHubAuthenticationRuntime {
    fn drop(&mut self) {
        let _ = self.supervisor.shutdown();
    }
}

/// Directory-owned redacted control-plane adapter; it never persists credentials.
pub(crate) struct GitHubAuthenticationProvider {
    runtime: Arc<GitHubAuthenticationRuntime>,
    service: Mutex<Weak<LoginService>>,
    active: Arc<Mutex<BTreeMap<LoginId, LoginId>>>,
}
impl GitHubAuthenticationProvider {
    pub(crate) fn new(runtime: Arc<GitHubAuthenticationRuntime>) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            service: Mutex::new(Weak::new()),
            active: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }
    pub(crate) fn install_login_service(&self, service: &Arc<LoginService>) {
        *self.service.lock().expect("authentication service lock") = Arc::downgrade(service);
        self.runtime
            .subscribers
            .lock()
            .expect("authentication subscribers lock")
            .push(Arc::downgrade(service));
    }
}
impl InteractiveLoginDriver for GitHubAuthenticationProvider {
    fn provider_id(&self) -> &'static str {
        github::GITHUB_PROVIDER_ID
    }
    fn account_multiplicity(&self) -> AccountMultiplicity {
        AccountMultiplicity::Multiple
    }
    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self.read_accounts()?.into_iter().next())
    }
    fn read_accounts(&self) -> Result<Vec<AccountSnapshot>, LoginError> {
        if let AuthenticationResponse::Accounts(accounts) = self
            .runtime
            .authentication(AuthenticationRequest::ReadAccounts)?
        {
            Ok(accounts)
        } else {
            Err(unavailable())
        }
    }
    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        let local_id = request.login_id;
        let remote_id = LoginId::new(format!(
            "github-{:016x}",
            self.runtime.next_login.fetch_add(1, Ordering::Relaxed)
        ))?;
        let response =
            self.runtime
                .authentication(AuthenticationRequest::Begin(BeginLoginRequest {
                    login_id: remote_id.clone(),
                    method: request.method,
                }))?;
        let AuthenticationResponse::Begun(started) = response else {
            return Err(unavailable());
        };
        self.active
            .lock()
            .expect("authentication attempts lock")
            .insert(local_id.clone(), remote_id.clone());
        self.runtime
            .attempts
            .lock()
            .expect("profile attempts lock")
            .insert(remote_id.clone(), AttemptState::Active);
        let attempts = self.runtime.attempts.clone();
        let active = self.active.clone();
        let expected_incarnation = self.runtime.supervisor.snapshot().incarnation;
        let runtime = Arc::downgrade(&self.runtime);
        let service = self
            .service
            .lock()
            .expect("authentication service lock")
            .clone();
        let completion_id = local_id.clone();
        let cancel_id = remote_id.clone();
        let worker = std::thread::Builder::new()
            .name("github-login-completion".into())
            .spawn(move || {
                let until = std::time::Instant::now() + Duration::from_secs(610);
                loop {
                    let state = attempts
                        .lock()
                        .expect("profile attempts lock")
                        .get(&remote_id)
                        .copied();
                    match state {
                        Some(AttemptState::Active) => {}
                        Some(AttemptState::Cancelled) | None => break,
                        Some(AttemptState::LoggedOut) => {
                            if let Some(service) = service.upgrade() {
                                fail_login(
                                    &service,
                                    completion_id.clone(),
                                    "github_login_cancelled",
                                    "GitHub login cancelled by logout",
                                );
                            }
                            break;
                        }
                    }
                    let Some(runtime) = runtime.upgrade() else {
                        break;
                    };
                    let Some(service) = service.upgrade() else {
                        let _ = runtime
                            .authentication(AuthenticationRequest::Cancel(remote_id.clone()));
                        break;
                    };
                    let completion = runtime
                        .authentication(AuthenticationRequest::PollCompletion(remote_id.clone()));
                    if runtime.supervisor.snapshot().incarnation != expected_incarnation {
                        fail_login(
                            &service,
                            completion_id.clone(),
                            "github_extension_restarted",
                            "GitHub authentication extension restarted",
                        );
                        break;
                    }
                    match completion {
                        Ok(AuthenticationResponse::Completion(Some(mut completion))) => {
                            completion.login_id = completion_id.clone();
                            let _ = service.complete(completion);
                            runtime.publish_accounts();
                            break;
                        }
                        Err(_) => {
                            let _ = service.complete(ash_login::CompleteLogin {
                                login_id: completion_id.clone(),
                                outcome: ash_login::LoginCompletionOutcome::Failed {
                                    failure: ash_login::LoginFailure {
                                        code: "github_extension_unavailable".into(),
                                        message: "GitHub authentication extension unavailable"
                                            .into(),
                                    },
                                },
                            });
                            break;
                        }
                        Ok(
                            AuthenticationResponse::Accounts(_)
                            | AuthenticationResponse::Begun(_)
                            | AuthenticationResponse::Cancelled(_)
                            | AuthenticationResponse::LoggedOut
                            | AuthenticationResponse::Completion(None),
                        ) => {}
                    }
                    if std::time::Instant::now() >= until {
                        let _ = runtime
                            .authentication(AuthenticationRequest::Cancel(remote_id.clone()));
                        fail_login(
                            &service,
                            completion_id.clone(),
                            "github_login_timed_out",
                            "GitHub login timed out",
                        );
                        break;
                    }
                    drop(runtime);
                    drop(service);
                    std::thread::sleep(Duration::from_millis(100));
                }
                active
                    .lock()
                    .expect("authentication attempts lock")
                    .remove(&completion_id);
                attempts
                    .lock()
                    .expect("profile attempts lock")
                    .remove(&remote_id);
            });
        if worker.is_err() {
            let _ = self
                .runtime
                .authentication(AuthenticationRequest::Cancel(cancel_id.clone()));
            self.active
                .lock()
                .expect("authentication attempts lock")
                .remove(&local_id);
            self.runtime
                .attempts
                .lock()
                .expect("profile attempts lock")
                .remove(&cancel_id);
            return Err(unavailable());
        }
        Ok(match started {
            BeginLogin::Browser {
                authorization_url, ..
            } => BeginLogin::Browser {
                login_id: local_id,
                authorization_url,
            },
            BeginLogin::Connected { account, .. } => BeginLogin::Connected {
                login_id: local_id,
                account,
            },
            BeginLogin::DeviceCode {
                verification_url,
                user_code,
                ..
            } => BeginLogin::DeviceCode {
                login_id: local_id,
                verification_url,
                user_code,
            },
        })
    }
    fn cancel(&self, id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let Some(id) = self
            .active
            .lock()
            .expect("authentication attempts lock")
            .remove(id)
        else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        self.runtime
            .attempts
            .lock()
            .expect("profile attempts lock")
            .insert(id.clone(), AttemptState::Cancelled);
        if let AuthenticationResponse::Cancelled(outcome) = self
            .runtime
            .authentication(AuthenticationRequest::Cancel(id))?
        {
            Ok(outcome)
        } else {
            Err(unavailable())
        }
    }
    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        self.runtime
            .authentication(AuthenticationRequest::Logout(account.clone()))?;
        for state in self
            .runtime
            .attempts
            .lock()
            .expect("profile attempts lock")
            .values_mut()
        {
            *state = AttemptState::LoggedOut;
        }
        self.runtime.publish_accounts();
        Ok(())
    }
}
impl GitHubCredentialProvider for GitHubAuthenticationProvider {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError> {
        self.authorization_inner(None)
    }
    fn authorization_for(&self, id: &str) -> Result<GitHubAuthorization, LoginError> {
        self.authorization_inner(Some(id.into()))
    }
    fn token(&self, grant: &GitHubAuthorization) -> Result<SecretValue, LoginError> {
        if let GitHubAuthenticationResponse::Token(value) = self
            .runtime
            .call(GitHubAuthenticationRequest::Token(grant.clone()), None)?
        {
            Ok(SecretValue::new(value))
        } else {
            Err(unavailable())
        }
    }
}
impl GitHubAuthenticationProvider {
    fn authorization_inner(
        &self,
        account_id: Option<String>,
    ) -> Result<GitHubAuthorization, LoginError> {
        if let GitHubAuthenticationResponse::Authorization(grant) = self.runtime.call(
            GitHubAuthenticationRequest::Authorization { account_id },
            None,
        )? {
            Ok(grant)
        } else {
            Err(unavailable())
        }
    }
}
impl GitHubAccountManager for GitHubAuthenticationProvider {
    fn accounts(&self) -> Result<Vec<GitHubAccount>, LoginError> {
        if let GitHubAuthenticationResponse::Accounts(accounts) = self
            .runtime
            .call(GitHubAuthenticationRequest::Accounts, None)?
        {
            Ok(accounts)
        } else {
            Err(unavailable())
        }
    }
    fn connect_token(
        &self,
        host: &str,
        token: SecretValue,
        cancellation: &CancellationToken,
    ) -> Result<GitHubAccount, LoginError> {
        let host = host.trim().to_ascii_lowercase();
        github::Repository::new(host.clone(), "account".into(), "identity".into())
            .map_err(|_| LoginError::new(LoginErrorKind::InvalidInput, "GitHub host is invalid"))?;
        let url = if host == "github.com" {
            "https://api.github.com/user".into()
        } else {
            format!("https://{host}/api/v3/user")
        };
        self.runtime
            .allowed_http
            .lock()
            .expect("authentication HTTP grants lock")
            .insert(url);
        if let GitHubAuthenticationResponse::Connected(account) = self.runtime.call(
            GitHubAuthenticationRequest::ConnectToken {
                host,
                token: token.expose().to_vec(),
            },
            Some(cancellation),
        )? {
            self.runtime.publish_accounts();
            Ok(account)
        } else {
            Err(unavailable())
        }
    }
}

fn service(
    request: CoreServiceRequest,
    allowed: &Mutex<BTreeSet<String>>,
    http: &dyn HttpClient,
    secrets: &dyn SecretStore,
    cancellation: &CancellationToken,
) -> Result<CoreServiceResponse, HostFailure> {
    cancellation.check().map_err(|_| denied())?;
    match request {
        CoreServiceRequest::SecretLoad { key } => Ok(CoreServiceResponse::SecretLoaded {
            value: secrets
                .load(&secret_key(key)?)
                .map_err(|_| denied())?
                .map(|value| value.expose().to_vec()),
        }),
        CoreServiceRequest::SecretStore { key, value } => {
            secrets
                .store(&secret_key(key)?, &SecretValue::new(value))
                .map_err(|_| denied())?;
            Ok(CoreServiceResponse::SecretStored)
        }
        CoreServiceRequest::SecretDelete { key } => Ok(CoreServiceResponse::SecretDeleted {
            deleted: secrets.delete(&secret_key(key)?).map_err(|_| denied())?
                == ash_secrets::DeleteSecretOutcome::Deleted,
        }),
        CoreServiceRequest::HttpExecute {
            method,
            url,
            headers,
            body,
        } => {
            if !url.starts_with("https://") || !allowed.lock().map_err(|_| denied())?.contains(&url)
            {
                return Err(denied());
            }
            if !(method == CoreHttpMethod::Get && url.ends_with("/user")
                || method == CoreHttpMethod::Post && url.ends_with("/v1/oauth/github/token"))
            {
                return Err(denied());
            }
            let method = match method {
                CoreHttpMethod::Get => HttpMethod::Get,
                CoreHttpMethod::Post => HttpMethod::Post,
                CoreHttpMethod::Patch => HttpMethod::Patch,
                CoreHttpMethod::Put => HttpMethod::Put,
                CoreHttpMethod::Delete => HttpMethod::Delete,
            };
            let request = HttpRequest::new(
                method,
                url,
                headers
                    .into_iter()
                    .map(|(name, value)| HttpHeader::new(name, value))
                    .collect(),
                body,
            )
            .map_err(|_| denied())?
            .without_redirects();
            let response = http
                .execute_with_cancellation(&request, cancellation)
                .map_err(|_| HostFailure {
                    code: HostErrorCode::Internal,
                    message: "extension HTTP service unavailable".into(),
                })?;
            Ok(CoreServiceResponse::HttpExecuted {
                status: response.status(),
                headers: response
                    .headers()
                    .iter()
                    .map(|h| (h.name().into(), h.value().into()))
                    .collect(),
                body: response.body().to_vec(),
            })
        }
    }
}
fn secret_key(key: String) -> Result<ash_secrets::SecretKey, HostFailure> {
    if !matches!(
        key.as_str(),
        "provider/github/current/oauth" | "provider/github/accounts"
    ) {
        return Err(denied());
    }
    ash_secrets::SecretKey::new(key).map_err(|_| denied())
}
fn denied() -> HostFailure {
    HostFailure {
        code: HostErrorCode::PermissionDenied,
        message: "extension service access denied".into(),
    }
}
fn unavailable() -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "GitHub authentication extension unavailable",
    )
}

fn executable_digest(path: &Path) -> Result<String, std::io::Error> {
    use sha2::Digest;
    let bytes = std::fs::read(path)?;
    Ok(format!("sha256:{:x}", sha2::Sha256::digest(bytes)))
}
/// Resolves only the selected installation, with no PATH or profile-package fallback.
pub(crate) fn product_executable() -> Option<PathBuf> {
    let installation = ash_install_context::InstallContext::current();
    let layout = installation.package_layout()?;
    Some(layout.binary_directory().join(if cfg!(windows) {
        "ash-github-authentication.exe"
    } else {
        "ash-github-authentication"
    }))
}

impl Drop for GitHubAuthenticationProvider {
    fn drop(&mut self) {
        let active =
            std::mem::take(&mut *self.active.lock().expect("authentication attempts lock"));
        for id in active.into_values() {
            self.runtime
                .attempts
                .lock()
                .expect("profile attempts lock")
                .insert(id.clone(), AttemptState::Cancelled);
            let _ = self
                .runtime
                .authentication(AuthenticationRequest::Cancel(id));
        }
    }
}

fn fail_login(service: &LoginService, login_id: LoginId, code: &str, message: &str) {
    let _ = service.complete(ash_login::CompleteLogin {
        login_id,
        outcome: ash_login::LoginCompletionOutcome::Failed {
            failure: ash_login::LoginFailure {
                code: code.into(),
                message: message.into(),
            },
        },
    });
}
