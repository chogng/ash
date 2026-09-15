//! Trusted embedding-process handoff, separate from the public policy/config parser.
use crate::Error;
use crate::ErrorCode;
use crate::SandboxRequest;
use serde::Deserialize;
use serde::Serialize;
use wxc_common::models::ExecutionRequest;
use wxc_common::sandbox_process::SandboxProcess;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Launch {
    request: ExecutionRequest,
    host_acl_scope: Option<wxc_common::host_changes::HostAclScope>,
    host_filesystem: Option<wxc_common::host_changes::HostFilesystemAccess>,
    host_filesystem_roots: Vec<String>,
    require_process_security_environment: bool,
    prepared_files: Option<wxc_common::filesystem_object::FilesystemSnapshot>,
    bubblewrap_executable: Option<std::path::PathBuf>,
}

/// Encodes a prepared embedding request for a trusted child process, preserving host authority.
/// This is not a public sandbox configuration and must never be accepted from an untrusted client.
pub fn encode_inherited_launch(request: &SandboxRequest) -> Result<String, Error> {
    let r = &request.inner;
    serde_json::to_string(&Launch {
        request: r.clone(),
        host_acl_scope: r.host_acl_scope.clone(),
        host_filesystem: r.host_filesystem,
        host_filesystem_roots: r.host_filesystem_roots.clone(),
        require_process_security_environment: r.require_process_security_environment,
        prepared_files: r.prepared_files.clone(),
        bubblewrap_executable: r.bubblewrap_executable.clone(),
    })
    .map_err(|_| Error::new(ErrorCode::MalformedRequest, "invalid inherited launch"))
}

/// Runs inside the dedicated embedding helper with an already attached terminal.
/// Accept only a launch envelope supplied by the embedding host, never public configuration.
pub fn spawn_inherited_launch(encoded: &str) -> Result<Box<dyn SandboxProcess>, Error> {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err(Error::new(
            ErrorCode::MalformedRequest,
            "inherited launch requires terminal stdio",
        ));
    }
    let launch: Launch = serde_json::from_str(encoded)
        .map_err(|_| Error::new(ErrorCode::MalformedRequest, "invalid inherited launch"))?;
    let mut request = launch.request;
    request.host_acl_scope = launch.host_acl_scope;
    request.host_filesystem = launch.host_filesystem;
    request.host_filesystem_roots = launch.host_filesystem_roots;
    request.require_process_security_environment = launch.require_process_security_environment;
    request.prepared_files = launch.prepared_files;
    request.bubblewrap_executable = launch.bubblewrap_executable;
    if let Some(snapshot) = &request.prepared_files {
        snapshot
            .validate()
            .map_err(|_| Error::new(ErrorCode::MalformedRequest, "prepared filesystem changed"))?;
    }
    crate::dispatch::spawn_inherited(&request).map_err(Error::from)
}

#[cfg(test)]
#[path = "inherited_tests.rs"]
mod tests;
