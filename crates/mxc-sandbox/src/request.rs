//! Prepared MXC requests owned by the Ash adapter, independent of SDK dispatch.
use crate::unavailable;
use ash_sandboxing::FilesystemSnapshot;
use ash_sandboxing::SandboxError;
use mxc_sdk::mxc_common::logger::Logger;
use mxc_sdk::mxc_common::logger::Mode;
use mxc_sdk::mxc_common::models::ExecutionRequest;
use mxc_sdk::mxc_common::sandbox_process::SandboxBackend;
use mxc_sdk::mxc_common::sandbox_process::SandboxProcess;
use mxc_sdk::mxc_common::sandbox_process::StdioMode;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug)]
pub(super) struct Request {
    pub inner: ExecutionRequest,
    snapshot: FilesystemSnapshot,
    // These controls deliberately do not deserialize through MXC's public config.
    bubblewrap: Option<PathBuf>,
    private_ipc: Vec<String>,
    proxy_port: Option<u16>,
    #[cfg(target_os = "macos")]
    seatbelt_rules: String,
}

// The handoff carries Ash's concrete execution controls, never a serialized SDK
// implementation model. Rebuilding through the published contract retains its validation.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handoff {
    command_line: String,
    cwd: String,
    environment: Option<Vec<String>>,
    readwrite_paths: Vec<String>,
    readonly_paths: Vec<String>,
    denied_paths: Vec<String>,
    network: HandoffNetwork,
    snapshot: FilesystemSnapshot,
    bubblewrap: Option<PathBuf>,
    private_ipc: Vec<String>,
    #[cfg(target_os = "macos")]
    seatbelt_rules: String,
}

#[derive(Serialize, Deserialize)]
enum HandoffNetwork {
    Allowed,
    Denied,
    Managed(u16),
}

impl Serialize for Request {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let network = match self.proxy_port {
            Some(port) => HandoffNetwork::Managed(port),
            None => match self.inner.policy.default_network_policy {
                mxc_sdk::mxc_common::models::NetworkPolicy::Allow => HandoffNetwork::Allowed,
                mxc_sdk::mxc_common::models::NetworkPolicy::Block => HandoffNetwork::Denied,
            },
        };
        Handoff {
            command_line: self.inner.script_code.clone(),
            cwd: self.inner.working_directory.clone(),
            environment: self.inner.env.clone(),
            readwrite_paths: self.inner.policy.readwrite_paths.clone(),
            readonly_paths: self.inner.policy.readonly_paths.clone(),
            denied_paths: self.inner.policy.denied_paths.clone(),
            network,
            snapshot: self.snapshot.clone(),
            bubblewrap: self.bubblewrap.clone(),
            private_ipc: self.private_ipc.clone(),
            #[cfg(target_os = "macos")]
            seatbelt_rules: self.seatbelt_rules.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let handoff = Handoff::deserialize(deserializer)?;
        let (network, proxy_port) = match handoff.network {
            HandoffNetwork::Allowed => (ash_sandboxing::NetworkAccess::Allowed, None),
            HandoffNetwork::Denied => (ash_sandboxing::NetworkAccess::Denied, None),
            HandoffNetwork::Managed(port) => (ash_sandboxing::NetworkAccess::Managed, Some(port)),
        };
        let files = mxc_sdk::mxc_common::models::ContainerPolicy {
            readwrite_paths: handoff.readwrite_paths,
            readonly_paths: handoff.readonly_paths,
            denied_paths: handoff.denied_paths,
            ..Default::default()
        };
        let mut inner = crate::policy::sdk_request(
            handoff.command_line,
            handoff.cwd,
            files,
            network,
            proxy_port,
        )
        .map_err(serde::de::Error::custom)?;
        inner.env = handoff.environment;
        Ok(Self {
            inner,
            snapshot: handoff.snapshot,
            bubblewrap: handoff.bubblewrap,
            private_ipc: handoff.private_ipc,
            proxy_port,
            #[cfg(target_os = "macos")]
            seatbelt_rules: handoff.seatbelt_rules,
        })
    }
}

impl Request {
    pub fn new(inner: ExecutionRequest) -> Result<Self, SandboxError> {
        let proxy_port = inner
            .policy
            .network_proxy
            .address
            .as_ref()
            .map(|address| address.port());
        let snapshot_paths = inner
            .policy
            .readwrite_paths
            .iter()
            .chain(&inner.policy.readonly_paths)
            .chain(&inner.policy.denied_paths)
            .map(PathBuf::from)
            .chain(std::iter::once(PathBuf::from(&inner.working_directory)))
            .map(snapshot_path)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|error| unavailable(error.to_string()))?;
        let snapshot = FilesystemSnapshot::capture(snapshot_paths)
            .map_err(|error| unavailable(error.to_string()))?;
        Ok(Self {
            inner,
            snapshot,
            bubblewrap: None,
            private_ipc: Vec::new(),
            proxy_port,
            #[cfg(target_os = "macos")]
            seatbelt_rules: String::new(),
        })
    }

    pub fn set_env(&mut self, environment: &[(String, String)]) {
        self.inner.env = Some(
            environment
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect(),
        );
        self.inner.inherit_default_env = false;
    }

    pub fn set_bubblewrap_executable(&mut self, path: &Path) {
        self.bubblewrap = Some(path.to_owned());
    }

    #[cfg(target_os = "macos")]
    pub fn set_private_ipc(&mut self, paths: Vec<String>) {
        self.private_ipc = paths;
    }

    #[cfg(target_os = "macos")]
    pub fn set_seatbelt_rules(&mut self, rules: String) {
        self.seatbelt_rules = rules;
    }

    pub fn prepare(&self) -> Result<(), SandboxError> {
        self.snapshot
            .validate()
            .map_err(|error| unavailable(error.to_string()))?;
        #[cfg(windows)]
        mxc_sdk::process_container_common::base_container_runner::BaseContainerRunner::require_psec(
            &self.inner,
        )
        .map_err(|error| {
            if error.code == mxc_sdk::mxc_common::mxc_error::MxcErrorCode::UnsupportedContainment {
                SandboxError::UnsupportedPolicy(error.to_string())
            } else {
                unavailable(error.to_string())
            }
        })?;
        Ok(())
    }

    pub fn spawn(mut self, stdio: StdioMode) -> Result<Box<dyn SandboxProcess>, SandboxError> {
        self.restore_runtime_policy();
        self.prepare()?;
        self.inner.bubblewrap_executable = self.bubblewrap;
        #[cfg(target_os = "macos")]
        {
            let seatbelt = self.inner.seatbelt.get_or_insert_with(Default::default);
            seatbelt.allow_unix_sockets = false;
            seatbelt.allowed_unix_socket_paths = self.private_ipc;
            if !self.seatbelt_rules.is_empty() {
                if seatbelt.profile_override.is_some() {
                    return Err(SandboxError::UnsupportedPolicy(
                        "continuous path rules cannot extend a Seatbelt profile override".into(),
                    ));
                }
                let mut profile =
                    mxc_sdk::seatbelt_common::profile_builder::build_profile_with_proxy(
                        &self.inner,
                        self.inner.policy.network_proxy.address.as_ref(),
                    )
                    .map_err(SandboxError::UnsupportedPolicy)?;
                profile.push_str(&self.seatbelt_rules);
                self.inner
                    .seatbelt
                    .as_mut()
                    .expect("Seatbelt configuration was created above")
                    .profile_override = Some(profile);
            }
        }
        let mut logger = Logger::new(Mode::Buffer);
        #[cfg(windows)]
        let mut backend =
            mxc_sdk::process_container_common::base_container_runner::BaseContainerRunner::new();
        #[cfg(target_os = "linux")]
        let mut backend = mxc_sdk::bwrap_common::bwrap_runner::BubblewrapScriptRunner::new();
        #[cfg(target_os = "macos")]
        let mut backend = mxc_sdk::seatbelt_common::seatbelt_runner::SeatbeltScriptRunner::new();
        let result = backend
            .spawn(&self.inner, &mut logger, stdio)
            .map_err(spawn_error);
        for warning in logger.take_warnings() {
            log::warn!(target: "sandbox", "MXC execution diagnostic: {warning}");
        }
        result
    }

    fn restore_runtime_policy(&mut self) {
        // Ash always supplies an explicit network policy and uses one owned
        // loopback endpoint. MXC deliberately omits these fields from its config serialization.
        let policy = &mut self.inner.policy;
        policy.network_specified = true;
        policy.network_mode_specified = true;
        policy.ui_specified = cfg!(windows);
        policy.runtime_network_proxy_specified = self.proxy_port.is_some();
        policy.network_proxy.address = self
            .proxy_port
            .map(|port| mxc_sdk::mxc_common::models::ProxyAddress::new("127.0.0.1".into(), port));
    }
}

// A Unix socket cannot be opened as a file. Its deny is attached to its pathname,
// while the containing directory supplies the handle-bound authority for that path.
fn snapshot_path(path: PathBuf) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if std::fs::metadata(&path)?.file_type().is_socket() {
            return Ok(path
                .parent()
                .expect("a socket path has a parent")
                .to_owned());
        }
    }
    Ok(path)
}

fn spawn_error(error: mxc_sdk::mxc_common::models::ScriptResponse) -> SandboxError {
    use mxc_sdk::mxc_common::models::FailurePhase;
    let code = match error.failure_phase {
        FailurePhase::BackendUnavailable => "backend_unavailable",
        FailurePhase::Rejected => "policy_validation",
        FailurePhase::None
        | FailurePhase::LaunchFailed
        | FailurePhase::PostLaunchFailed
        | FailurePhase::ProcessExited
        | FailurePhase::Timeout => "backend_error",
    };
    let mut message = format!("{code}: {}", error.error_message);
    if !error.extended_error.is_empty() {
        message.push_str(&format!(" ({})", error.extended_error));
    }
    // A launch error never reopens backend selection. SDK failure categories
    // describe the diagnosis, but do not attest that user code never started.
    SandboxError::StartFailed {
        timing: ash_sandboxing::SandboxDenialTiming::ProcessMayHaveStarted,
        message,
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;

/// Materialize host visibility as ordinary PSEC grants, without authorizing ACL changes.
#[cfg(windows)]
pub(super) fn host_paths(cwd: &Path) -> Result<Vec<String>, SandboxError> {
    let mut roots = (0..26)
        .map(|index| PathBuf::from(format!("{}:\\", char::from(b'A' + index))))
        .collect::<Vec<_>>();
    if let Some(root) = cwd.ancestors().last() {
        roots.push(root.to_owned());
    }
    roots.sort();
    roots.dedup();
    let mut paths = Vec::new();
    for root in roots {
        match std::fs::read_dir(&root) {
            Ok(entries) => {
                paths.push(root);
                for entry in entries {
                    let path = entry
                        .map_err(|error| unavailable(error.to_string()))?
                        .path();
                    // Generated visibility does not authorize inaccessible objects.
                    // Explicit grants were captured separately and always fail closed.
                    use mxc_sdk::mxc_common::filesystem_object::{
                        ExistingObjectComparison, compare_existing_filesystem_objects,
                    };
                    if compare_existing_filesystem_objects(&path, &path)
                        != ExistingObjectComparison::Same
                    {
                        continue;
                    }
                    paths.push(path);
                    if paths.len() > 4096 {
                        return Err(unavailable("host filesystem expansion exceeds 4096 paths"));
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
                ) || matches!(error.raw_os_error(), Some(21 | 53 | 1201 | 1167)) => {}
            Err(error) => return Err(unavailable(error.to_string())),
        }
    }
    paths
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| unavailable("MXC requires Unicode filesystem paths"))
        })
        .collect()
}
