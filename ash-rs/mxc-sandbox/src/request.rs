//! Prepared MXC requests owned by the Ash adapter, independent of SDK dispatch.
use crate::unavailable;
use ash_sandboxing::SandboxError;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use wxc_common::filesystem_object::FilesystemSnapshot;
use wxc_common::logger::Logger;
use wxc_common::logger::Mode;
use wxc_common::models::ExecutionRequest;
use wxc_common::sandbox_process::SandboxBackend;
use wxc_common::sandbox_process::SandboxProcess;
use wxc_common::sandbox_process::StdioMode;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub inner: ExecutionRequest,
    snapshot: FilesystemSnapshot,
    // These controls deliberately do not deserialize through MXC's public config.
    bubblewrap: Option<PathBuf>,
    private_ipc: Vec<String>,
    proxy_port: Option<u16>,
}

impl Request {
    pub fn new(inner: ExecutionRequest) -> Result<Self, SandboxError> {
        let proxy_port = inner
            .policy
            .network_proxy
            .address
            .as_ref()
            .map(|address| address.port());
        let snapshot = FilesystemSnapshot::capture(
            inner
                .policy
                .readwrite_paths
                .iter()
                .chain(&inner.policy.readonly_paths)
                .chain(&inner.policy.denied_paths)
                .map(PathBuf::from)
                .chain(std::iter::once(PathBuf::from(&inner.working_directory))),
        )
        .map_err(|error| unavailable(error.to_string()))?;
        Ok(Self {
            inner,
            snapshot,
            bubblewrap: None,
            private_ipc: Vec::new(),
            proxy_port,
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

    pub fn prepare(&self) -> Result<(), SandboxError> {
        self.snapshot
            .validate()
            .map_err(|error| unavailable(error.to_string()))?;
        #[cfg(windows)]
        appcontainer_common::base_container_runner::BaseContainerRunner::require_psec(&self.inner)
            .map_err(|error| {
                if error.code == wxc_common::mxc_error::MxcErrorCode::UnsupportedContainment {
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
        }
        let mut logger = Logger::new(Mode::Buffer);
        #[cfg(windows)]
        let mut backend = appcontainer_common::base_container_runner::BaseContainerRunner::new();
        #[cfg(target_os = "linux")]
        let mut backend = bwrap_common::bwrap_runner::BubblewrapScriptRunner::new();
        #[cfg(target_os = "macos")]
        let mut backend = seatbelt_common::seatbelt_runner::SeatbeltScriptRunner::new();
        let result = backend
            .spawn(&self.inner, &mut logger, stdio)
            .map_err(|error| ash_sandboxing::SandboxError::StartFailed {
                timing: ash_sandboxing::SandboxDenialTiming::ProcessMayHaveStarted,
                message: error.error_message,
            });
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
            .map(|port| wxc_common::models::ProxyAddress::new("127.0.0.1".into(), port));
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
                    use wxc_common::filesystem_object::{
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
