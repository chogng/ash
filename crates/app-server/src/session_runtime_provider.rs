//! Generic product composition for an optional Session runtime DataChannel.
//! Provisioning belongs to the executable; the gateway reuses its admitted stdio entrypoint.

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
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionRuntimeRequest;
use ash_protocol::SessionRuntimeResult;
use external_ext_protocol::ActivateParams;
use external_ext_protocol::ExtensionCapability;
use external_ext_protocol::PackageBinding;
use sha2::Digest;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const PROVIDER_ID: &str = "ash.dev-containers";
const BINARY: &str = "ash-dev-container-provider";
const CHANNEL: &str = "sessionRuntime.v1";

/// Stopping retires connections but retains the source authorization needed to remove the
/// container later, including after reopening the profile or deleting its configuration.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum RuntimeTarget {
    Ready { target: SessionExecutionTarget },
    Stopped { target: SessionExecutionTarget },
}
impl RuntimeTarget {
    fn target(&self) -> &SessionExecutionTarget {
        match self {
            Self::Ready { target } | Self::Stopped { target } => target,
        }
    }
}

struct Authority(Arc<ash_core_plugins::EditorExtensionPolicy>);
impl ActivationLease for Authority {}
impl ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.is_extension_enabled(PROVIDER_ID)
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Self(self.0.clone())) as Box<dyn ActivationLease>)
    }
}

/// One profile owns activation and the persisted set of admitted execution targets.
pub(crate) struct SessionRuntimeProvider {
    executable: Option<PathBuf>,
    policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
    supervisor: Mutex<Option<ExtensionHostSupervisor>>,
    operations: Mutex<()>,
    targets: Mutex<Vec<RuntimeTarget>>,
    target_file: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    generation: AtomicU64,
    probe: RuntimeConnectionProbe,
}

pub(crate) type RuntimeConnectionProbe = fn(
    Arc<SessionRuntimeProvider>,
    &SessionExecutionTarget,
    PathBuf,
    &CancellationToken,
) -> Result<(), String>;

/// Selected by product composition. No client or profile manifest supplies a program path.
pub(crate) struct SessionRuntimeInstallation {
    pub(crate) executable: PathBuf,
    pub(crate) environment: BTreeMap<OsString, OsString>,
}

pub(crate) fn product_installation() -> Option<SessionRuntimeInstallation> {
    let executable = if let Some(path) = std::env::var_os("ASH_DEV_CONTAINER_PROVIDER_PATH") {
        PathBuf::from(path)
    } else {
        let installation = ash_install_context::InstallContext::current();
        installation
            .package_layout()?
            .binary_directory()
            .join(format!("{BINARY}{}", std::env::consts::EXE_SUFFIX))
    };
    Some(SessionRuntimeInstallation {
        executable,
        environment: provider_environment(),
    })
}

impl SessionRuntimeProvider {
    pub(crate) fn open(
        profile: &Path,
        policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
        installation: Option<SessionRuntimeInstallation>,
        probe: RuntimeConnectionProbe,
    ) -> Result<Arc<Self>, String> {
        let target_file = profile.join("session-runtime-targets.json");
        let targets: Vec<RuntimeTarget> = match std::fs::symlink_metadata(&target_file) {
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.is_file()
                    && metadata.len() <= 1024 * 1024 =>
            {
                serde_json::from_slice(
                    &std::fs::read(&target_file).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            _ => return Err("invalid session runtime target store".into()),
        };
        if targets.len() > 32 || targets.iter().any(|entry| !valid_target(entry.target())) {
            return Err("invalid session runtime targets".into());
        }
        let (executable, environment) = match installation {
            Some(installation) => (Some(installation.executable), installation.environment),
            None => (None, BTreeMap::new()),
        };
        let updates = policy.subscribe();
        let runtime = Arc::new(Self {
            executable,
            policy,
            supervisor: Mutex::new(None),
            operations: Mutex::new(()),
            targets: Mutex::new(targets),
            target_file,
            environment,
            generation: AtomicU64::new(1),
            probe,
        });
        let weak = Arc::downgrade(&runtime);
        std::thread::Builder::new()
            .name("ash-session-runtime-authority".into())
            .spawn(move || {
                loop {
                    match updates.recv_timeout(Duration::from_millis(100)) {
                        Ok(_) => {
                            let Some(runtime) = weak.upgrade() else {
                                break;
                            };
                            // Retire the activation even if disable/enable both completed before
                            // this observer ran. Old routes cannot revive after a policy change.
                            runtime.generation.fetch_add(1, Ordering::AcqRel);
                            let supervisor = runtime
                                .supervisor
                                .lock()
                                .ok()
                                .and_then(|mut state| state.take());
                            if let Some(supervisor) = supervisor {
                                let _ = supervisor.shutdown();
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if weak.strong_count() == 0 {
                                break;
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(runtime)
    }

    fn start(&self) -> Result<std::sync::MutexGuard<'_, Option<ExtensionHostSupervisor>>, String> {
        if !self.policy.is_extension_enabled(PROVIDER_ID) {
            return Err("session runtime Provider is disabled".into());
        }
        let mut state = self
            .supervisor
            .lock()
            .map_err(|_| "runtime lock poisoned")?;
        if state.is_none() {
            let path = self
                .executable
                .as_ref()
                .ok_or("session runtime Provider is unavailable")?
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let launcher =
                ProductExecutableLauncher::new(path.clone()).map_err(|error| error.to_string())?;
            let command = ExtensionLaunchCommand::new(
                path.clone(),
                std::iter::empty::<String>(),
                path.parent().ok_or("invalid runtime path")?,
                self.environment.clone(),
            )
            .map_err(|error| error.to_string())?;
            let digest = format!(
                "sha256:{:x}",
                sha2::Sha256::digest(std::fs::read(&path).map_err(|error| error.to_string())?)
            );
            let activation = ExtensionActivationSpec::new(
                ActivateParams {
                    initialization: None,
                    extension_id: PROVIDER_ID.into(),
                    package: PackageBinding {
                        package_id: PROVIDER_ID.into(),
                        package_digest: digest,
                        entrypoint: BINARY.into(),
                    },
                    runtime_api_version: 1,
                    activation_events: vec!["onSessionRuntime".into()],
                    capabilities: vec![ExtensionCapability::DataChannel],
                },
                NonZeroU64::new(1).expect("generation"),
                Arc::new(Authority(self.policy.clone())),
            );
            *state = Some(
                ExtensionHostSupervisor::new(
                    Arc::new(launcher),
                    command,
                    activation,
                    ExtensionHostLimits {
                        isolation: ProcessIsolationPolicy::AuthorizedProduct,
                        request_timeout: Duration::from_secs(600),
                        ..ExtensionHostLimits::default()
                    },
                    RestartPolicy::default(),
                )
                .map_err(|error| error.to_string())?,
            );
        }
        state
            .as_ref()
            .expect("created supervisor")
            .start()
            .map_err(|error| error.to_string())?;
        Ok(state)
    }

    pub(crate) fn invoke(
        self: &Arc<Self>,
        provider: &str,
        request: SessionRuntimeRequest,
        cancellation: &CancellationToken,
    ) -> Result<SessionRuntimeResult, String> {
        if provider != PROVIDER_ID {
            return Err("unknown session runtime Provider".into());
        }
        if cancellation.is_cancelled() {
            return Err("runtime operation cancelled".into());
        }
        if matches!(request, SessionRuntimeRequest::List) {
            let targets = if self.is_enabled() {
                self.targets
                    .lock()
                    .map_err(|_| "runtime targets lock poisoned")?
                    .iter()
                    .map(|entry| entry.target().clone())
                    .collect()
            } else {
                Vec::new()
            };
            return Ok(SessionRuntimeResult::Targets { targets });
        }
        // Serialize the whole preparation, including readiness and admission. Serializing only
        // the SDK tool call lets a concurrent Stop finish before an older probe republishes it.
        let _operation = loop {
            cancellation.check().map_err(|error| error.to_string())?;
            match self.operations.try_lock() {
                Ok(operation) => break operation,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("runtime operation lock poisoned".into());
                }
            }
        };
        let generation = self.generation();
        let expected_workspace = match &request {
            SessionRuntimeRequest::Prepare { workspace } => {
                Some(dunce::canonicalize(workspace).map_err(|error| error.to_string())?)
            }
            _ => None,
        };
        let control = match &request {
            SessionRuntimeRequest::Remove { workspace } => Some((workspace.clone(), true)),
            SessionRuntimeRequest::Stop { workspace } => Some((workspace.clone(), false)),
            _ => None,
        };
        if let Some((workspace, _)) = &control {
            if !self.targets.lock().map_err(|_| "runtime targets lock poisoned")?.iter().any(|entry| matches!(entry.target(), SessionExecutionTarget::Provider { workspace: source, .. } if source == workspace)) {
                return Err("container control requires an admitted workspace".into());
            }
        }
        let state = match self.start() {
            Ok(state) => state,
            Err(_) if matches!(request, SessionRuntimeRequest::Probe { .. }) => {
                return Ok(SessionRuntimeResult::Availability { available: false });
            }
            Err(error) => return Err(error),
        };
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64
            + 600_000;
        let handle = state
            .as_ref()
            .expect("started supervisor")
            .begin_invoke(ExtensionInvocation {
                registration_id: CHANNEL.into(),
                operation: "receiveData".into(),
                payload: serde_json::to_value(request).map_err(|error| error.to_string())?,
                deadline_unix_millis: NonZeroU64::new(deadline).ok_or("invalid deadline")?,
            })
            .map_err(|error| error.to_string())?;
        // Never hold activation's mutex while a build runs; another window may probe/cancel.
        drop(state);
        let completed = AtomicBool::new(false);
        let output = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !completed.load(Ordering::Acquire) {
                    if cancellation.is_cancelled() || !self.policy.is_extension_enabled(PROVIDER_ID)
                    {
                        let _ = handle.cancel(external_ext_protocol::CancelReason::Caller);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            });
            let result = handle.wait();
            completed.store(true, Ordering::Release);
            result
        })
        .map_err(|error| error.to_string())?;
        if cancellation.is_cancelled()
            || !self.policy.is_extension_enabled(PROVIDER_ID)
            || generation != self.generation()
        {
            return Err("runtime operation cancelled".into());
        }
        let result: SessionRuntimeResult =
            serde_json::from_value(output.payload).map_err(|error| error.to_string())?;
        if let SessionRuntimeResult::Target { target } = &result {
            if !valid_target(target)
                || !matches!(target, SessionExecutionTarget::Provider { workspace, .. } if Some(workspace) == expected_workspace.as_ref())
            {
                return Err("invalid Provider target".into());
            }
            let executable = self
                .executable
                .as_ref()
                .ok_or("session runtime Provider is unavailable")?
                .canonicalize()
                .map_err(|error| error.to_string())?;
            (self.probe)(self.clone(), target, executable, cancellation)?;
            if cancellation.is_cancelled() || generation != self.generation() || !self.is_enabled()
            {
                return Err("runtime preparation cancelled".into());
            }
            let mut targets = self
                .targets
                .lock()
                .map_err(|_| "runtime targets lock poisoned")?;
            let mut next = targets.clone();
            next.retain(|existing| !same_workspace(existing.target(), target));
            if next.len() >= 32 {
                return Err("session runtime target capacity exhausted".into());
            }
            next.push(RuntimeTarget::Ready {
                target: target.clone(),
            });
            self.save(&next)?;
            *targets = next;
        } else if let Some((workspace, remove)) = control {
            if !matches!(result, SessionRuntimeResult::Released) {
                return Err("invalid Provider control result".into());
            }
            let mut targets = self
                .targets
                .lock()
                .map_err(|_| "runtime targets lock poisoned")?;
            let mut next = targets.clone();
            if remove {
                next.retain(|entry| !matches!(entry.target(), SessionExecutionTarget::Provider { workspace: path, .. } if path == &workspace));
            } else {
                for entry in &mut next {
                    if matches!(entry.target(), SessionExecutionTarget::Provider { workspace: path, .. } if path == &workspace)
                    {
                        *entry = RuntimeTarget::Stopped {
                            target: entry.target().clone(),
                        };
                    }
                }
            }
            self.save(&next)?;
            *targets = next;
        }
        Ok(result)
    }

    fn save(&self, targets: &[RuntimeTarget]) -> Result<(), String> {
        let bytes = serde_json::to_vec(targets).map_err(|error| error.to_string())?;
        ash_utils_path::write_atomically(&self.target_file, &bytes)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn targets(&self) -> Vec<SessionExecutionTarget> {
        if !self.policy.is_extension_enabled(PROVIDER_ID) {
            return Vec::new();
        }
        self.targets
            .lock()
            .expect("runtime targets lock")
            .iter()
            .filter_map(|entry| match entry {
                RuntimeTarget::Ready { target } => Some(target.clone()),
                RuntimeTarget::Stopped { .. } => None,
            })
            .collect()
    }
    pub(crate) fn executable(&self, target: &SessionExecutionTarget) -> Result<PathBuf, String> {
        if !self.is_admitted(target) || !valid_target(target) {
            return Err("execution target has not been admitted by its Provider".into());
        }
        self.executable
            .as_ref()
            .ok_or("session runtime Provider is unavailable")?
            .canonicalize()
            .map_err(|error| error.to_string())
    }
    pub(crate) fn is_admitted(&self, target: &SessionExecutionTarget) -> bool {
        self.policy.is_extension_enabled(PROVIDER_ID)
            && self.targets.lock().is_ok_and(|targets| {
                targets
                    .iter()
                    .any(|candidate| matches!(candidate, RuntimeTarget::Ready { target: candidate } if same_workspace(candidate, target)))
            })
    }
    pub(crate) fn is_enabled(&self) -> bool {
        self.policy.is_extension_enabled(PROVIDER_ID)
    }
    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub(crate) fn environment(&self) -> Vec<(String, String)> {
        self.environment
            .iter()
            .filter_map(|(key, value)| Some((key.to_str()?.into(), value.to_str()?.into())))
            .collect()
    }
}

fn provider_environment() -> BTreeMap<OsString, OsString> {
    // Tool credentials/configuration stay with Docker. Internal product connection tokens,
    // model keys and unrelated provider secrets never enter this executable.
    [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "TMP",
        "TEMP",
        "XDG_RUNTIME_DIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "ASH_DEVCONTAINER_CLI",
        "ASH_DOCKER_PATH",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
    .collect()
}

fn valid_target(target: &SessionExecutionTarget) -> bool {
    matches!(target, SessionExecutionTarget::Provider { provider_id, workspace, root }
        if provider_id == PROVIDER_ID && workspace.is_absolute() && !workspace.as_os_str().as_encoded_bytes().contains(&0)
            && ash_remote::RemoteDirPath::parse(root).is_ok_and(|directory| directory.as_str() == root) && root.len() <= 4096)
}
fn same_workspace(left: &SessionExecutionTarget, right: &SessionExecutionTarget) -> bool {
    matches!((left, right), (SessionExecutionTarget::Provider { provider_id: a, workspace: x, .. }, SessionExecutionTarget::Provider { provider_id: b, workspace: y, .. }) if a == b && x == y)
}

#[cfg(test)]
#[path = "session_runtime_provider_tests.rs"]
mod tests;
