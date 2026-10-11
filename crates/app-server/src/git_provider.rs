//! Admission and transport for the product Git provider; no repository state lives here.

use crate::git_service::GitServiceError;
use ash_app_server_protocol::git_provider::*;
use ash_async_utils::CancellationToken;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::ExtensionActivationSpec;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionInvocationTarget;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::ProcessIsolationPolicy;
use ash_external_ext::ProductExecutableLauncher;
use ash_external_ext::RestartPolicy;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use external_ext_protocol::ActivateParams;
use external_ext_protocol::ExtensionCapability;
use external_ext_protocol::PackageBinding;
use sha2::Digest;
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

// Clone retains the Git client's 15-minute budget; transport allows final cleanup.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(915);

struct ProductAuthority(Arc<Vec<Authorization>>, Arc<AtomicBool>);
impl ActivationLease for ProductAuthority {}
impl ActivationAuthority for ProductAuthority {
    fn authorizes(&self) -> bool {
        !self.1.load(Ordering::Acquire)
            && self
                .0
                .iter()
                .all(|authorization| authorization.ensure_active().is_ok())
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Self(self.0.clone(), self.1.clone())) as Box<dyn ActivationLease>)
    }
}

#[derive(Default)]
struct Binding {
    incarnation: u64,
    watching: Option<GitProviderPolicy>,
}

pub(crate) struct GitProviderClient {
    supervisor: ExtensionHostSupervisor,
    directories: Vec<GitProviderDir>,
    authorizations: Arc<Vec<Authorization>>,
    binding: Mutex<Binding>,
    retired: Arc<AtomicBool>,
}

impl GitProviderClient {
    pub(crate) fn open(
        executable: PathBuf,
        directories: Vec<(Option<String>, Authorization)>,
    ) -> Result<Arc<Self>, GitProviderError> {
        let executable =
            std::fs::canonicalize(executable).map_err(|_| GitProviderError::Unavailable)?;
        let launcher = Arc::new(
            ProductExecutableLauncher::new(executable.clone())
                .map_err(|_| GitProviderError::Unavailable)?,
        );
        let command = ExtensionLaunchCommand::new(
            executable.clone(),
            std::iter::empty::<String>(),
            executable.parent().ok_or(GitProviderError::Unavailable)?,
            git_environment()?,
        )
        .map_err(|_| GitProviderError::Unavailable)?;
        let roots = directories
            .iter()
            .map(|(id, authorization)| GitProviderDir {
                id: id.clone(),
                path: authorization.dir().canonical_path().to_path_buf(),
                can_mutate: authorization.permission() == Permission::MutateRepository,
            })
            .collect();
        if directories.iter().any(|(_, authorization)| {
            !matches!(
                authorization.permission(),
                Permission::InspectRepository | Permission::MutateRepository
            )
        }) {
            return Err(GitProviderError::Unavailable);
        }
        let authorizations = Arc::new(
            directories
                .into_iter()
                .map(|(_, authorization)| authorization)
                .collect::<Vec<_>>(),
        );
        let digest = sha2::Sha256::digest(
            std::fs::read(&executable).map_err(|_| GitProviderError::Unavailable)?,
        );
        let retired = Arc::new(AtomicBool::new(false));
        let activation = ExtensionActivationSpec::new(
            ActivateParams {
                initialization: None,
                extension_id: GIT_PROVIDER_ID.into(),
                package: PackageBinding {
                    package_id: GIT_PROVIDER_ID.into(),
                    package_digest: format!("sha256:{digest:x}"),
                    entrypoint: "ash-git-extension".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onGitRepository".into()],
                capabilities: vec![ExtensionCapability::DataChannel],
            },
            NonZeroU64::new(1).expect("activation generation"),
            Arc::new(ProductAuthority(authorizations.clone(), retired.clone())),
        );
        let supervisor = ExtensionHostSupervisor::new(
            launcher,
            command,
            activation,
            ExtensionHostLimits {
                maximum_payload_bytes: GIT_PROVIDER_PAYLOAD_BYTES,
                maximum_frame_bytes: GIT_PROVIDER_PAYLOAD_BYTES + 1024 * 1024,
                request_timeout: REQUEST_TIMEOUT,
                isolation: ProcessIsolationPolicy::AuthorizedProduct,
                ..ExtensionHostLimits::default()
            },
            RestartPolicy::default(),
        )
        .map_err(|_| GitProviderError::Unavailable)?;
        let client = Arc::new(Self {
            supervisor,
            directories: roots,
            authorizations,
            binding: Mutex::new(Binding::default()),
            retired,
        });
        Ok(client)
    }

    pub(crate) fn call(
        &self,
        request: GitProviderRequest,
        cancellation: Option<&CancellationToken>,
    ) -> Result<GitProviderResponse, GitProviderError> {
        self.ensure_authorized()?;
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(GitProviderError::Cancelled);
        }
        let snapshot = self
            .supervisor
            .start()
            .map_err(|_| GitProviderError::Unavailable)?;
        self.ensure_authorized()?;
        let incarnation = snapshot.incarnation;
        {
            let mut binding = self.binding.lock().map_err(|_| GitProviderError::Runtime)?;
            if binding.incarnation != incarnation {
                let bound = self.invoke(
                    incarnation,
                    GitProviderRequest::Bind {
                        version: GIT_PROVIDER_VERSION,
                        directories: self.directories.clone(),
                    },
                    cancellation,
                );
                if let Err(error) = bound {
                    // A cancelled bootstrap may already have bound the child. Retire that
                    // incarnation before any subsequent request can reuse partial setup.
                    let _ = self.supervisor.shutdown();
                    return Err(error);
                }
                if let Some(policy) = binding.watching {
                    self.invoke(
                        incarnation,
                        GitProviderRequest::StartWatching { policy },
                        cancellation,
                    )?;
                }
                binding.incarnation = incarnation;
            }
            if let GitProviderRequest::StartWatching { policy }
            | GitProviderRequest::Configure { policy } = &request
            {
                binding.watching = Some(*policy);
            }
        }
        self.invoke(incarnation, request, cancellation)
    }

    fn invoke(
        &self,
        incarnation: u64,
        request: GitProviderRequest,
        cancellation: Option<&CancellationToken>,
    ) -> Result<GitProviderResponse, GitProviderError> {
        self.ensure_authorized()?;
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GitProviderError::Runtime)?
            .as_millis() as u64
            + REQUEST_TIMEOUT.as_millis() as u64;
        let target = ExtensionInvocationTarget {
            incarnation: NonZeroU64::new(incarnation).ok_or(GitProviderError::Unavailable)?,
            activation_generation: NonZeroU64::new(1).expect("activation generation"),
        };
        let handle = self
            .supervisor
            .begin_fenced_invoke(
                target,
                ExtensionInvocation {
                    registration_id: GIT_PROVIDER_CHANNEL.into(),
                    operation: "receiveData".into(),
                    payload: serde_json::to_value(request)
                        .map_err(|_| GitProviderError::Runtime)?,
                    deadline_unix_millis: NonZeroU64::new(deadline)
                        .ok_or(GitProviderError::Runtime)?,
                },
            )
            .map_err(|_| GitProviderError::Unavailable)?;
        let completed = AtomicBool::new(false);
        let output = std::thread::scope(|scope| {
            let completed = &completed;
            let handle = &handle;
            scope.spawn(move || {
                while !completed.load(Ordering::Acquire) {
                    if cancellation.is_some_and(CancellationToken::is_cancelled)
                        || self.ensure_authorized().is_err()
                    {
                        let _ = handle.cancel(external_ext_protocol::CancelReason::Caller);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            });
            let output = handle.wait();
            completed.store(true, Ordering::Release);
            output
        });
        self.ensure_authorized()?;
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(GitProviderError::Cancelled);
        }
        let output = output.map_err(|_| GitProviderError::Unavailable)?;
        serde_json::from_value::<Result<GitProviderResponse, GitProviderError>>(output.payload)
            .map_err(|_| GitProviderError::Runtime)?
    }

    pub(crate) fn shutdown(&self) {
        self.retired.store(true, Ordering::Release);
        let _ = self.supervisor.shutdown();
    }
    pub(crate) fn ensure_authorized(&self) -> Result<(), GitProviderError> {
        if self.retired.load(Ordering::Acquire)
            || self
                .authorizations
                .iter()
                .any(|authorization| authorization.ensure_active().is_err())
        {
            self.shutdown();
            Err(GitProviderError::Unavailable)
        } else {
            Ok(())
        }
    }
}

impl Drop for GitProviderClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn service_error(error: GitProviderError) -> GitServiceError {
    match error {
        GitProviderError::Cancelled => GitServiceError::Cancelled,
        GitProviderError::Boundary => GitServiceError::Boundary,
        GitProviderError::BranchNotFound => GitServiceError::BranchNotFound,
        GitProviderError::CommitChangeNotFound => GitServiceError::CommitChangeNotFound,
        GitProviderError::ConflictChanged => GitServiceError::ConflictChanged,
        GitProviderError::IndexChanged => GitServiceError::Git(ash_git::GitError::IndexChanged),
        GitProviderError::NotAWorkingTree => {
            GitServiceError::Git(ash_git::GitError::NotAWorkingTree {
                path: PathBuf::new(),
            })
        }
        GitProviderError::OperationFailed { detail } => {
            GitServiceError::Git(ash_git::GitError::runtime("Git provider", detail))
        }
        GitProviderError::Unavailable => GitServiceError::Permission,
        GitProviderError::Runtime
        | GitProviderError::InvalidGraphCursor
        | GitProviderError::RepositoryNotFound => GitServiceError::Runtime,
    }
}

/// Uses the declared product installation; never searches the working directory or PATH.
pub(crate) fn product_executable() -> Result<PathBuf, GitProviderError> {
    let context = ash_install_context::InstallContext::current();
    if context.method() == ash_install_context::InstallMethod::Other {
        if let Some(path) = std::env::var_os("ASH_GIT_EXTENSION_BIN") {
            let path = PathBuf::from(path);
            return if path.is_absolute() && path.is_file() {
                Ok(path)
            } else {
                Err(GitProviderError::Unavailable)
            };
        }
    }
    let layout = context
        .package_layout()
        .ok_or(GitProviderError::Unavailable)?;
    Ok(layout.binary_directory().join(if cfg!(windows) {
        "ash-git-extension.exe"
    } else {
        "ash-git-extension"
    }))
}

fn git_environment() -> Result<BTreeMap<std::ffi::OsString, std::ffi::OsString>, GitProviderError> {
    // Preserve Git's user configuration and credential helpers without inheriting unrelated
    // product credentials or repository-selector variables into the provider process.
    let mut environment = BTreeMap::new();
    for name in [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "SSH_AUTH_SOCK",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "GIT_SSL_CAINFO",
        "GIT_SSL_CAPATH",
    ] {
        if let Some(value) = std::env::var_os(name) {
            environment.insert(name.into(), value);
        }
    }
    environment.insert(
        "PATH".into(),
        ash_install_context::SystemExecutables::current()
            .search_path()
            .map_err(|_| GitProviderError::Unavailable)?,
    );
    Ok(environment)
}
