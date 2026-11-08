//! A dedicated helper inherits the PTY; the shared host never replaces its own stdio.
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxLaunch;
use ash_sandboxing::SandboxScope;
use ash_utils_pty::TerminalSize;
use std::collections::HashMap;
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
        crate::pty_transport::decode(std::env::vars_os()).map_err(|error| error.to_string())?;
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
        crate::pty_transport::encode(&encoded, &mut helper_env)
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
