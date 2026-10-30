//! Product adapter for the optional GitHub API capability. No GitHub API implementation
//! is linked here: the host grants each invocation only its captured account and network.
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::BuiltInExtensionRuntime;
use ash_external_ext::ExtensionActivationSpec;
use ash_external_ext::ExtensionHostError;
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
use github::Error;
use github::GitHubAuthenticationRequest;
use github::GitHubAuthenticationResponse;
use github::GitHubAuthorization;
use github::GitHubCredentialProvider;
use github::GitHubInvocation;
use github::GitHubProvider;
use github::GitHubRequest;
use github::GitHubResponse;
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const ID: &str = "ash.github";
struct Authority(Arc<ash_core_plugins::EditorExtensionPolicy>);
impl ActivationLease for Authority {}
impl ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.is_extension_enabled(ID)
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Self(self.0.clone())) as Box<dyn ActivationLease>)
    }
}

/// Profile-scoped supervisor. Calls carry their own credential authority; no sessions
/// or API caches are mirrored in this adapter, and startup remains capability-driven.
pub(crate) struct GitHubExtensionRuntime {
    executable: PathBuf,
    supervisor: ExtensionHostSupervisor,
    policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
    lifecycle: Mutex<CancellationSource>,
}
impl GitHubExtensionRuntime {
    pub(crate) fn open(
        executable: PathBuf,
        policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
    ) -> github::Result<Arc<Self>> {
        use sha2::Digest;
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
        .map_err(|_| unavailable())?;
        let digest = format!(
            "sha256:{:x}",
            sha2::Sha256::digest(std::fs::read(&executable).map_err(|_| unavailable())?)
        );
        let activation = ExtensionActivationSpec::new(
            ActivateParams {
                initialization: None,
                extension_id: ID.into(),
                package: PackageBinding {
                    package_id: ID.into(),
                    package_digest: digest,
                    entrypoint: "ash-github-extension".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onCapability:github.api.v2".into()],
                capabilities: vec![ExtensionCapability::DataChannel],
            },
            NonZeroU64::new(1).expect("activation generation"),
            Arc::new(Authority(policy.clone())),
        );
        let mut limits = ExtensionHostLimits {
            isolation: ProcessIsolationPolicy::AuthorizedProduct,
            ..Default::default()
        };
        limits.request_timeout = Duration::from_secs(600);
        limits.maximum_frame_bytes = 32 * 1024 * 1024;
        limits.maximum_payload_bytes = 24 * 1024 * 1024;
        let supervisor = ExtensionHostSupervisor::new(
            launcher,
            command,
            activation,
            limits,
            RestartPolicy::default(),
        )
        .map_err(|_| unavailable())?;
        Ok(Arc::new(Self {
            executable,
            supervisor,
            policy,
            lifecycle: Mutex::new(CancellationSource::new()),
        }))
    }
    pub(crate) fn matches(&self, executable: &Path) -> bool {
        std::fs::canonicalize(executable).is_ok_and(|path| path == self.executable)
    }
    pub(crate) fn provider(
        self: &Arc<Self>,
        credentials: Option<Arc<dyn GitHubCredentialProvider>>,
        http: Arc<dyn HttpClient>,
    ) -> Arc<dyn GitHubProvider> {
        Arc::new(Provider {
            runtime: self.clone(),
            credentials,
            http,
        })
    }
    fn start(&self) -> github::Result<CancellationToken> {
        let mut lifecycle = self.lifecycle.lock().map_err(|_| unavailable())?;
        if !self.policy.is_extension_enabled(ID) {
            return Err(unavailable());
        }
        if lifecycle.token().is_cancelled() {
            *lifecycle = CancellationSource::new();
        }
        self.supervisor.start().map_err(|_| unavailable())?;
        Ok(lifecycle.token())
    }
}
impl BuiltInExtensionRuntime for GitHubExtensionRuntime {
    fn id(&self) -> &str {
        ID
    }
    fn is_running(&self) -> bool {
        self.supervisor.is_running()
    }
    fn reconcile_enablement(&self) -> Result<(), ExtensionHostError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        if !self.policy.is_extension_enabled(ID) {
            _lifecycle.cancel();
            self.supervisor.shutdown()?;
        }
        Ok(())
    }
}
impl Drop for GitHubExtensionRuntime {
    fn drop(&mut self) {
        let _ = self.supervisor.shutdown();
    }
}
struct Provider {
    runtime: Arc<GitHubExtensionRuntime>,
    credentials: Option<Arc<dyn GitHubCredentialProvider>>,
    http: Arc<dyn HttpClient>,
}
impl GitHubProvider for Provider {
    fn check_available(&self) -> github::Result<()> {
        if self.runtime.policy.is_extension_enabled(ID) {
            Ok(())
        } else {
            Err(unavailable())
        }
    }

    fn call(
        &self,
        authorization: Option<GitHubAuthorization>,
        request: GitHubRequest,
        cancellation: &CancellationToken,
    ) -> github::Result<GitHubResponse> {
        cancellation.check().map_err(|_| Error::Cancelled)?;
        // Only product issue search is anonymous. All other operations bind a live grant
        // before the extension can request any service or observe private data.
        if let Some(grant) = &authorization {
            self.credentials
                .as_ref()
                .ok_or(Error::AuthenticationRequired)?
                .token(grant)
                .map_err(Error::from)?;
        } else if !matches!(
            request,
            GitHubRequest::ReporterSearch { .. } | GitHubRequest::ShareLink(_)
        ) {
            return Err(Error::AuthenticationRequired);
        }
        let write = request.is_write();
        let runtime_cancellation = self.runtime.start()?;
        let payload = serde_json::to_value(GitHubInvocation {
            authorization: authorization.clone(),
            request,
        })
        .map_err(|_| Error::InvalidInput("Invalid GitHub invocation".into()))?;
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unavailable())?
            .as_millis() as u64
            + 600_000;
        let handle = self
            .runtime
            .supervisor
            .begin_invoke(ExtensionInvocation {
                registration_id: "github.api.v2".into(),
                operation: "receiveData".into(),
                payload,
                deadline_unix_millis: NonZeroU64::new(deadline).ok_or_else(unavailable)?,
            })
            .map_err(|_| {
                if write {
                    Error::SubmissionUncertain
                } else {
                    unavailable()
                }
            })?;
        let output = std::thread::scope(|scope| {
            let (done, completion) = std::sync::mpsc::channel();
            let handle_ref = &handle;
            scope.spawn(move || {
                while completion.recv_timeout(Duration::from_millis(10))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    if cancellation.is_cancelled() || runtime_cancellation.is_cancelled() {
                        let _ = handle_ref.cancel(external_ext_protocol::CancelReason::Caller);
                        break;
                    }
                }
            });
            let result = handle.wait_with_client(|operation, token, _| {
                self.service(operation, authorization.as_ref(), token)
            });
            let _ = done.send(());
            result
        })
        .map_err(|_| {
            if write {
                Error::SubmissionUncertain
            } else if cancellation.is_cancelled() {
                Error::Cancelled
            } else {
                unavailable()
            }
        })?;
        let response: github::Result<GitHubResponse> = serde_json::from_value(output.payload)
            .map_err(|_| {
                if write {
                    Error::SubmissionUncertain
                } else {
                    Error::InvalidResponse("Invalid GitHub provider response".into())
                }
            })?;
        if !write {
            if !self.runtime.policy.is_extension_enabled(ID) {
                return Err(unavailable());
            }
            cancellation.check().map_err(|_| Error::Cancelled)?;
            if let Some(grant) = &authorization {
                self.credentials
                    .as_ref()
                    .ok_or(Error::AuthenticationRequired)?
                    .token(grant)
                    .map_err(Error::from)?;
            }
        }
        response
    }
}
impl Provider {
    fn service(
        &self,
        operation: ExtensionClientOperation,
        grant: Option<&GitHubAuthorization>,
        cancellation: &CancellationToken,
    ) -> Result<ExtensionClientResult, HostFailure> {
        cancellation.check().map_err(|_| denied())?;
        if !self.runtime.policy.is_extension_enabled(ID) {
            return Err(denied());
        }
        match operation {
            ExtensionClientOperation::BackendRequest {
                capability,
                method,
                params,
                progress: None,
            } if capability == "authentication.github" && method == "receiveData" => {
                let request: GitHubAuthenticationRequest =
                    serde_json::from_value(params).map_err(|_| denied())?;
                let GitHubAuthenticationRequest::Token(requested) = request else {
                    return Err(denied());
                };
                if Some(&requested) != grant {
                    return Err(denied());
                }
                let response = self
                    .credentials
                    .as_ref()
                    .ok_or_else(denied)?
                    .token(&requested)
                    .map(|token| GitHubAuthenticationResponse::Token(token.expose().to_vec()));
                Ok(ExtensionClientResult::Value {
                    value: serde_json::to_value(response).map_err(|_| denied())?,
                })
            }
            ExtensionClientOperation::CoreService {
                request:
                    CoreServiceRequest::HttpExecute {
                        method,
                        url,
                        headers,
                        body,
                    },
            } => {
                let parsed = url::Url::parse(&url).map_err(|_| denied())?;
                let host = grant.map_or("github.com", |grant| grant.host.as_str());
                let api_host = if host == "github.com" {
                    "api.github.com"
                } else {
                    host
                };
                if parsed.scheme() != "https"
                    || parsed.host_str() != Some(api_host)
                    || parsed.port().is_some()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.fragment().is_some()
                    || (host != "github.com"
                        && !(parsed.path().starts_with("/api/v3/")
                            || parsed.path() == "/api/graphql"))
                    || (grant.is_none()
                        && !(method == CoreHttpMethod::Get && parsed.path() == "/search/issues"))
                {
                    return Err(denied());
                }
                let mut headers = headers
                    .into_iter()
                    .map(|(name, value)| HttpHeader::new(name, value))
                    .collect::<Vec<_>>();
                if let Some(grant) = grant {
                    let token = self
                        .credentials
                        .as_ref()
                        .ok_or_else(denied)?
                        .token(grant)
                        .map_err(|_| denied())?;
                    let token = std::str::from_utf8(token.expose()).map_err(|_| denied())?;
                    // Credentials and authority headers are owned by this host binding.
                    headers.retain(|header| {
                        !header.name().eq_ignore_ascii_case("authorization")
                            && !header.name().eq_ignore_ascii_case("host")
                            && !header.name().eq_ignore_ascii_case("proxy-authorization")
                    });
                    headers.push(HttpHeader::new("Authorization", format!("Bearer {token}")));
                } else if headers.iter().any(|header| {
                    ["authorization", "host", "proxy-authorization"]
                        .iter()
                        .any(|name| header.name().eq_ignore_ascii_case(name))
                }) {
                    return Err(denied());
                }
                let method = match method {
                    CoreHttpMethod::Get => HttpMethod::Get,
                    CoreHttpMethod::Post => HttpMethod::Post,
                    CoreHttpMethod::Patch => HttpMethod::Patch,
                    CoreHttpMethod::Put => HttpMethod::Put,
                    CoreHttpMethod::Delete => HttpMethod::Delete,
                };
                let request = HttpRequest::new(method, url, headers, body)
                    .map_err(|_| denied())?
                    .without_redirects();
                // Keep the existing per-attempt bound even though the API operation
                // may make several calls (pagination, review identity checks).
                let source = cancellation.child_source();
                let response = std::thread::scope(|scope| {
                    let (done, completion) = std::sync::mpsc::channel();
                    let source_ref = &source;
                    scope.spawn(move || {
                        if completion.recv_timeout(Duration::from_secs(30))
                            == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                        {
                            source_ref
                                .cancel_with(ash_async_utils::CancellationReason::DeadlineExceeded);
                        }
                    });
                    let response = self
                        .http
                        .execute_with_cancellation(&request, &source.token());
                    let _ = done.send(());
                    response
                })
                .map_err(|error| HostFailure {
                    code: if source.token().cancellation().is_some_and(|signal| {
                        *signal.reason() == ash_async_utils::CancellationReason::DeadlineExceeded
                    }) || matches!(
                        error,
                        ash_http_client::HttpClientError::Connection(
                            ash_http_client::HttpConnectionFailure::Timeout
                        )
                    ) {
                        HostErrorCode::DeadlineExceeded
                    } else {
                        HostErrorCode::Internal
                    },
                    message: "GitHub extension HTTP service unavailable".into(),
                })?;
                if response.body().len() > 8 * 1024 * 1024 {
                    return Err(denied());
                }
                Ok(ExtensionClientResult::CoreService {
                    response: CoreServiceResponse::HttpExecuted {
                        status: response.status(),
                        headers: response
                            .headers()
                            .iter()
                            .map(|header| (header.name().into(), header.value().into()))
                            .collect(),
                        body: response.body().to_vec(),
                    },
                })
            }
            _ => Err(denied()),
        }
    }
}
fn denied() -> HostFailure {
    HostFailure {
        code: HostErrorCode::PermissionDenied,
        message: "GitHub extension service access denied".into(),
    }
}
fn unavailable() -> Error {
    Error::Unavailable("GitHub API extension unavailable".into())
}
pub(crate) fn product_executable() -> Option<PathBuf> {
    let installation = ash_install_context::InstallContext::current();
    Some(
        installation
            .package_layout()?
            .binary_directory()
            .join(if cfg!(windows) {
                "ash-github-extension.exe"
            } else {
                "ash-github-extension"
            }),
    )
}

#[cfg(test)]
#[path = "github_extension_tests.rs"]
mod tests;
