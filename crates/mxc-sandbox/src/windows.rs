//! Windows PSEC host visibility and the helper that inherits its ConPTY.
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxLaunch;
use ash_sandboxing::SandboxScope;
use ash_utils_pty::TerminalSize;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

pub const PTY_HELPER_ARGUMENT: &str = "--ash-mxc-pty";

pub(super) fn prepare(
    command: &SandboxCommand,
    request: crate::request::Request,
    scope: &SandboxScope,
    size: TerminalSize,
    executable: PathBuf,
) -> Result<PreparedCommand, SandboxError> {
    if size.rows == 0 || size.cols == 0 {
        return Err(crate::unavailable("invalid terminal size"));
    }
    Ok(PreparedCommand::sandboxed(
        command,
        Launch {
            request,
            executable,
            cwd: command.working_directory().to_owned(),
            scope: scope.clone(),
            size,
        },
    ))
}

/// Internal process entrypoint, dispatched by arg0 before product startup.
/// The parent supplies a bounded, prepared request; diagnostics never echo the payload.
pub fn run_pty_helper() -> Result<i32, String> {
    let encoded =
        crate::windows_transport::decode(std::env::vars_os()).map_err(|error| error.to_string())?;
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err("PTY helper requires terminal stdio".into());
    }
    let request: crate::request::Request =
        serde_json::from_str(&encoded).map_err(|_| "invalid PTY launch request")?;
    let mut child = request
        .prepare()
        .map_err(|error| error.to_string())?
        .spawn_inherited()
        .map_err(|error| error.to_string())?;
    let status = child.wait().map_err(|error| error.to_string())?;
    Ok(match status {
        mxc_sdk::v1::WaitResult::Exited(code) => {
            if code >= 0 {
                code
            } else {
                1
            }
        }
        mxc_sdk::v1::WaitResult::TimedOut => 1,
    })
}

struct Launch {
    request: crate::request::Request,
    executable: PathBuf,
    cwd: PathBuf,
    scope: SandboxScope,
    size: TerminalSize,
}
impl SandboxLaunch for Launch {
    fn spawn(
        mut self: Box<Self>,
        environment: &[(String, String)],
    ) -> Result<ProcessHandle, SandboxError> {
        crate::policy::validate_paths(&self.cwd, &self.scope)?;
        self.request.set_env(environment)?;
        let encoded = serde_json::to_string(&self.request)
            .map_err(|_| crate::unavailable("cannot encode PTY launch"))?;
        let mut helper_env = HashMap::new();
        crate::windows_transport::encode(&encoded, &mut helper_env)
            .map_err(|error| crate::unavailable(error.to_string()))?;
        // Only loader-required variables enter the helper. Workload variables are inside the
        // prepared request, and MXC supplies those after applying the sandbox.
        for key in ["SystemRoot", "WINDIR"] {
            if let Ok(value) = std::env::var(key) {
                helper_env.insert(key.into(), value);
            }
        }
        ProcessHandle::spawn_pty(
            self.executable.into_os_string(),
            vec![PTY_HELPER_ARGUMENT.into()],
            self.cwd,
            helper_env,
            self.size,
        )
    }
}

/// Materialize host visibility as ordinary PSEC grants, without authorizing ACL changes.
pub(super) fn host_paths(
    cwd: &Path,
    access: FileSystemAccess,
    write_grants: &[String],
) -> Result<Vec<String>, SandboxError> {
    let mut roots = (0..26)
        .map(|index| PathBuf::from(format!("{}:\\", char::from(b'A' + index))))
        .collect::<Vec<_>>();
    if let Some(root) = cwd.ancestors().last() {
        roots.push(root.to_owned());
    }
    roots.sort();
    roots.dedup();
    expand_roots(roots, access, write_grants)
}

fn expand_roots(
    roots: impl IntoIterator<Item = PathBuf>,
    access: FileSystemAccess,
    write_grants: &[String],
) -> Result<Vec<String>, SandboxError> {
    let mut paths = Vec::new();
    for root in roots {
        match std::fs::read_dir(&root) {
            Ok(entries) => {
                // Read-only volume grants recurse. An existing write grant prevents
                // adding a read-only grant at that root, so keep its child read grants.
                let expand = match access {
                    FileSystemAccess::ReadOnly | FileSystemAccess::DirectoryWrite => {
                        write_grants.iter().any(|path| Path::new(path) == root)
                    }
                    FileSystemAccess::FullAccess => true,
                };
                paths.push(root);
                if !expand {
                    continue;
                }
                for entry in entries {
                    let path = entry
                        .map_err(|error| crate::unavailable(error.to_string()))?
                        .path();
                    // Generated visibility does not authorize inaccessible objects.
                    // Explicit grants were captured separately and always fail closed.
                    use mxc_sdk::v1::ExistingObjectComparison;
                    use mxc_sdk::v1::compare_existing_filesystem_objects;
                    if compare_existing_filesystem_objects(&path, &path)
                        != ExistingObjectComparison::Same
                    {
                        continue;
                    }
                    paths.push(path);
                    if paths.len() > 4096 {
                        return Err(crate::unavailable(
                            "host filesystem expansion exceeds 4096 paths",
                        ));
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
                ) || matches!(error.raw_os_error(), Some(21 | 53 | 1201 | 1167)) => {}
            Err(error) => return Err(crate::unavailable(error.to_string())),
        }
    }
    paths
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| crate::unavailable("MXC requires Unicode filesystem paths"))
        })
        .collect()
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
