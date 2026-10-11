//! Ash's approved launch specification; SDK requests exist only at the launch boundary.
use crate::unavailable;
use ash_sandboxing::FilesystemSnapshot;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxError;
use mxc_sdk::v1::FilesystemPolicy;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

// The same concrete specification crosses the Windows helper boundary. SDK implementation
// state is never persisted or reconstructed from a second representation of the policy.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub command_line: String,
    pub cwd: String,
    pub environment: Option<Vec<String>>,
    pub readwrite_paths: Vec<String>,
    pub readonly_paths: Vec<String>,
    pub denied_paths: Vec<String>,
    pub network: Network,
    snapshot: FilesystemSnapshot,
    bubblewrap: Option<PathBuf>,
    private_ipc: Vec<String>,
    #[cfg(target_os = "macos")]
    seatbelt_rules: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum Network {
    Allowed,
    Denied,
    #[cfg(not(windows))]
    Managed(std::num::NonZeroU16),
}

impl Request {
    pub fn new(
        command_line: String,
        cwd: String,
        files: FilesystemPolicy,
        network: NetworkAccess,
        proxy_port: Option<u16>,
    ) -> Result<Self, SandboxError> {
        let network = match (network, proxy_port) {
            (NetworkAccess::Allowed, None) => Network::Allowed,
            (NetworkAccess::Denied, None) => Network::Denied,
            #[cfg(windows)]
            (NetworkAccess::Managed, _) => return Err(crate::policy::unsupported_managed_network()),
            #[cfg(not(windows))]
            (NetworkAccess::Managed, Some(port)) if port != 0 => {
                Network::Managed(std::num::NonZeroU16::new(port).expect("port was checked"))
            }
            _ => {
                return Err(unavailable(
                    "managed networking requires one execution-owned HTTP/SOCKS endpoint",
                ));
            }
        };
        let paths = files
            .readwrite_paths
            .iter()
            .chain(&files.readonly_paths)
            .chain(&files.denied_paths)
            .map(PathBuf::from)
            .chain(std::iter::once(PathBuf::from(&cwd)))
            .map(snapshot_path)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|error| unavailable(error.to_string()))?;
        let snapshot =
            FilesystemSnapshot::capture(paths).map_err(|error| unavailable(error.to_string()))?;
        Ok(Self {
            command_line,
            cwd,
            environment: None,
            readwrite_paths: files.readwrite_paths,
            readonly_paths: files.readonly_paths,
            denied_paths: files.denied_paths,
            network,
            snapshot,
            bubblewrap: None,
            private_ipc: Vec::new(),
            #[cfg(target_os = "macos")]
            seatbelt_rules: String::new(),
        })
    }

    pub fn set_env(&mut self, environment: &[(String, String)]) {
        self.environment = Some(
            environment
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect(),
        );
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

    pub fn prepare(&self) -> Result<mxc_sdk::v1::RestrictedLaunch, SandboxError> {
        self.snapshot
            .validate()
            .map_err(|error| unavailable(error.to_string()))?;
        let mut options = mxc_sdk::v1::RestrictedLaunchOptions::default();
        options.bubblewrap_executable = self.bubblewrap.clone();
        options.unix_socket_paths = self.private_ipc.clone();
        #[cfg(target_os = "macos")]
        {
            options.seatbelt_denials = self.seatbelt_rules.clone();
        }
        mxc_sdk::v1::prepare_restricted(crate::policy::sdk_request(self)?, options).map_err(
            |error| {
                if error.code == mxc_sdk::v1::ErrorCode::UnsupportedContainment {
                    SandboxError::UnsupportedPolicy(error.to_string())
                } else {
                    unavailable(error.to_string())
                }
            },
        )
    }
}

pub(super) fn spawn_error(error: mxc_sdk::v1::Error) -> SandboxError {
    // SDK diagnoses a launch failure; it does not attest that user code never started.
    SandboxError::StartFailed {
        timing: ash_sandboxing::SandboxDenialTiming::ProcessMayHaveStarted,
        message: error.to_string(),
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
                    use mxc_sdk::v1::{
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
