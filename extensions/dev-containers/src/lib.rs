//! Optional Docker Provider. The reference CLI owns Dev Container configuration semantics.
//! No Docker policy or container metadata is linked into the shared App Server.

use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionRuntimeRequest;
use ash_protocol::SessionRuntimeResult;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use serde::Deserialize;
use std::ffi::OsString;
use std::io;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

pub const PROVIDER_ID: &str = "ash.dev-containers";
const MAX_OUTPUT: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(600);
mod bootstrap;

const RUNTIME_SELECTOR: &str = "if command -v ash-remote-server >/dev/null 2>&1; then runtime=ash-remote-server; elif [ -r \"$HOME/.local/share/ash/dev-container-runtime\" ]; then IFS= read -r runtime < \"$HOME/.local/share/ash/dev-container-runtime\"; else exit 127; fi; ";

/// Activation holds no competing container catalog: Docker labels are the authority.
#[derive(Default)]
pub struct DevContainers {
    operations: std::sync::Arc<std::sync::Mutex<()>>,
}
impl Extension for DevContainers {
    fn id(&self) -> &str {
        PROVIDER_ID
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let operations = self.operations.clone();
        context
            .data_channels
            .register("sessionRuntime.v1", move |request, token| {
                let _operation = loop {
                    token.check_cancelled()?;
                    match operations.try_lock() {
                        Ok(operation) => break operation,
                        Err(std::sync::TryLockError::WouldBlock) => {
                            thread::sleep(Duration::from_millis(25))
                        }
                        Err(std::sync::TryLockError::Poisoned(_)) => {
                            return Err(ExtensionError::new(
                                HostErrorCode::Internal,
                                "runtime operation lock failed",
                            ));
                        }
                    }
                };
                invoke(request, &token).map_err(|error| {
                    ExtensionError::new(HostErrorCode::Internal, error.to_string())
                })
            })
    }
}

fn executable(variable: &str, default: &str) -> OsString {
    std::env::var_os(variable).unwrap_or_else(|| {
        if cfg!(windows) && default == "devcontainer" {
            "devcontainer.cmd".into()
        } else {
            default.into()
        }
    })
}

fn workspace(path: &Path) -> io::Result<PathBuf> {
    // Preserve ordinary Windows paths for the Node CLI's workspace label identity.
    let path = dunce::canonicalize(path)?;
    if !path.is_dir()
        || (!path.join(".devcontainer/devcontainer.json").is_file()
            && !path.join(".devcontainer.json").is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace has no Dev Container configuration",
        ));
    }
    Ok(path)
}

/// Output is drained concurrently and bounded even when the tool is noisy. Cancellation reaps
/// the CLI before returning; killing a wait never stops a container another client may be using.
fn output(command: &mut Command, token: &CancellationToken) -> io::Result<Vec<u8>> {
    output_with_archive(command, token, None)
}

fn output_with_archive(
    command: &mut Command,
    token: &CancellationToken,
    archive: Option<std::fs::File>,
) -> io::Result<Vec<u8>> {
    token.check_cancelled().map_err(io::Error::other)?;
    let launch = ash_sandboxing::SandboxCommand::new(
        command.get_program(),
        command.get_args(),
        std::env::current_dir()?,
    );
    let mut child = ash_sandboxing::PreparedCommand::unrestricted(&launch)
        .spawn(&std::env::vars().collect::<Vec<_>>())
        .map_err(io::Error::other)?;
    let stdin = child.take_stdin().expect("piped stdin");
    let stdout = child.take_stdout().expect("piped stdout");
    let stderr = child.take_stderr().expect("piped stderr");
    thread::scope(|scope| {
        scope.spawn(move || {
            if let Some(mut archive) = archive {
                let mut stdin = stdin;
                let _ = io::copy(&mut archive, &mut stdin);
            }
        });
        scope.spawn(move || {
            let _ = io::copy(&mut std::io::BufReader::new(stderr), &mut io::stderr());
        });
        let reader = scope.spawn(move || {
            let mut bytes = Vec::new();
            // Continue draining after the limit so the child cannot block a cancellation/reap.
            let mut stream = stdout;
            let mut buffer = [0; 8192];
            loop {
                let read = stream.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                if bytes.len() + read > MAX_OUTPUT {
                    io::copy(&mut stream, &mut io::sink())?;
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "runtime output exceeded limit",
                    ));
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            Ok(bytes)
        });
        let deadline = Instant::now() + DEADLINE;
        loop {
            if token.is_cancellation_requested() || Instant::now() >= deadline {
                let _ = child.close();
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "container operation cancelled or timed out",
                ));
            }
            if let Some(status) = child.try_wait()? {
                let bytes = reader
                    .join()
                    .map_err(|_| io::Error::other("output reader failed"))??;
                if status != ash_sandboxing::SandboxProcessExitStatus::Code(0) {
                    return Err(io::Error::other("container tool failed; see provider log"));
                }
                return Ok(bytes);
            }
            thread::sleep(Duration::from_millis(25));
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpResult {
    outcome: String,
    container_id: String,
    remote_workspace_folder: String,
}

fn prepare(path: &Path, token: &CancellationToken) -> io::Result<SessionExecutionTarget> {
    let path = workspace(path)?;
    let result = output(
        Command::new(executable("ASH_DEVCONTAINER_CLI", "devcontainer"))
            .args(["up", "--workspace-folder"])
            .arg(&path),
        token,
    )?;
    let up: UpResult = serde_json::from_slice(&result).map_err(io::Error::other)?;
    if up.outcome != "success"
        || !valid_container_id(&up.container_id)
        || !valid_root(&up.remote_workspace_folder)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Dev Container CLI result",
        ));
    }
    // Install the matching container runtime when the image does not provide one. The product
    // adapter completes a protocol handshake before publishing the resulting target.
    let probe = format!("{RUNTIME_SELECTOR}exec \"$runtime\" --version");
    if output(container_command(&path).args(["sh", "-c", &probe]), token).is_err() {
        token.check_cancelled().map_err(io::Error::other)?;
        bootstrap::install(&path, token)?;
    }
    Ok(SessionExecutionTarget::Provider {
        provider_id: PROVIDER_ID.into(),
        workspace: path,
        root: up.remote_workspace_folder,
    })
}

fn valid_container_id(value: &str) -> bool {
    (12..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_root(value: &str) -> bool {
    ash_remote::RemoteDirPath::parse(value).is_ok()
}

fn containers(path: &Path, token: &CancellationToken) -> io::Result<Vec<String>> {
    let label = format!("label=devcontainer.local_folder={}", path.display());
    let bytes = output(
        Command::new(executable("ASH_DOCKER_PATH", "docker"))
            .args(["ps", "--all", "--quiet", "--no-trunc", "--filter"])
            .arg(label),
        token,
    )?;
    let text = String::from_utf8(bytes).map_err(io::Error::other)?;
    text.lines()
        .map(|line| {
            if valid_container_id(line) {
                Ok(line.into())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid Docker container identity",
                ))
            }
        })
        .collect()
}

fn invoke(
    request: SessionRuntimeRequest,
    token: &CancellationToken,
) -> io::Result<SessionRuntimeResult> {
    match request {
        SessionRuntimeRequest::List => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime target inventory belongs to the product host",
        )),
        SessionRuntimeRequest::Probe { workspace: path } => {
            let available = workspace(&path).is_ok()
                && output(
                    Command::new(executable("ASH_DOCKER_PATH", "docker")).args([
                        "info",
                        "--format",
                        "{{.ServerVersion}}",
                    ]),
                    token,
                )
                .is_ok()
                && output(
                    Command::new(executable("ASH_DEVCONTAINER_CLI", "devcontainer"))
                        .arg("--version"),
                    token,
                )
                .is_ok();
            token.check_cancelled().map_err(io::Error::other)?;
            Ok(SessionRuntimeResult::Availability { available })
        }
        SessionRuntimeRequest::Prepare { workspace } => Ok(SessionRuntimeResult::Target {
            target: prepare(&workspace, token)?,
        }),
        operation @ (SessionRuntimeRequest::Stop { .. } | SessionRuntimeRequest::Remove { .. }) => {
            let (path, remove) = match operation {
                SessionRuntimeRequest::Stop { workspace } => (workspace, false),
                SessionRuntimeRequest::Remove { workspace } => (workspace, true),
                SessionRuntimeRequest::List
                | SessionRuntimeRequest::Probe { .. }
                | SessionRuntimeRequest::Prepare { .. } => {
                    unreachable!()
                }
            };
            // Both operations act only on the CLI's workspace label, never an arbitrary ID.
            // The selected container may outlive its source folder/configuration. Stop and
            // removal address its original Docker label rather than reopening that folder.
            if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid container source",
                ));
            }
            for id in containers(&path, token)? {
                output(
                    Command::new(executable("ASH_DOCKER_PATH", "docker"))
                        .args(["stop", "--time", "10"])
                        .arg(&id),
                    token,
                )?;
                if remove {
                    output(
                        Command::new(executable("ASH_DOCKER_PATH", "docker"))
                            .args(["rm"])
                            .arg(&id),
                        token,
                    )?;
                }
            }
            Ok(SessionRuntimeResult::Released)
        }
    }
}

/// The gateway launches this mode only after preparation admitted the precise workspace/root.
/// Its pipes carry the existing App Server protocol, with no new framing or UI-owned transport.
pub fn connect(path: &Path, root: &str) -> io::Result<()> {
    let path = workspace(path)?;
    if !valid_root(root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid execution root",
        ));
    }
    let mut command = Command::new(executable("ASH_DEVCONTAINER_CLI", "devcontainer"));
    let connect =
        format!("{RUNTIME_SELECTOR}exec env \"ASH_WORKSPACE_ROOT=$1\" \"$runtime\" connect");
    command
        .args(["exec", "--workspace-folder"])
        .arg(&path)
        .args(["sh", "-c", &connect, "--", root])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec())
    }
    #[cfg(not(unix))]
    {
        let status = command.status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("container runtime disconnected"))
        }
    }
}

fn container_command(workspace: &Path) -> Command {
    let mut command = Command::new(executable("ASH_DEVCONTAINER_CLI", "devcontainer"));
    command.args(["exec", "--workspace-folder"]).arg(workspace);
    command
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
