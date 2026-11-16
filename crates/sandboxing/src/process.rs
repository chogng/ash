use crate::SandboxProcessExitStatus;
use std::io::Read;
use std::io::Write;

/// Renders a Windows launch, preserving the raw command string consumed by cmd.exe.
/// Backends that accept separate arguments after /C or /K retain their argv encoding.
#[cfg(windows)]
pub fn windows_command_line(
    argv: &[String],
    require_single_cmd_script: bool,
    render_argv: impl FnOnce(&[String]) -> Result<String, crate::SandboxError>,
) -> Result<String, crate::SandboxError> {
    let is_cmd = argv
        .first()
        .and_then(|program| std::path::Path::new(program).file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cmd.exe") || name.eq_ignore_ascii_case("cmd")
        });
    let script_switch = is_cmd
        .then(|| {
            argv.iter().position(|argument| {
                argument.eq_ignore_ascii_case("/c") || argument.eq_ignore_ascii_case("/k")
            })
        })
        .flatten();
    match script_switch {
        Some(index) if argv.len() == index + 2 => {
            // cmd consumes the tail as shell syntax. CRT backslash escaping
            // would corrupt quoted executable paths and script strings.
            Ok(format!(
                "{} \"{}\"",
                render_argv(&argv[..=index])?,
                argv[index + 1]
            ))
        }
        Some(_) if require_single_cmd_script => Err(crate::SandboxError::UnsupportedPolicy(
            "cmd.exe requires one command string after /C or /K".into(),
        )),
        _ => render_argv(argv),
    }
}

/// Backend-owned running process. Implementations close the complete process tree and its
/// isolation resources; callers drain taken streams and invoke close before releasing a proxy.
pub trait SandboxProcess: Send {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>>;
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>>;
    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>>;
    fn interrupt(&mut self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process interrupt is not supported by this sandbox backend",
        ))
    }
    fn resize(&mut self, _: ash_utils_pty::TerminalSize) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process is not attached to a PTY",
        ))
    }
    fn close(&mut self) -> io::Result<()>;
}

/// Ensures a backend process is closed on success, cancellation and early error returns.
pub struct ProcessHandle {
    inner: Box<dyn SandboxProcess>,
    backend: Option<std::sync::Arc<dyn crate::SandboxBackend>>,
}

impl ProcessHandle {
    pub fn new(process: impl SandboxProcess + 'static) -> Self {
        Self {
            inner: Box::new(process),
            backend: None,
        }
    }
    pub(crate) fn spawn_command(command: Command) -> io::Result<Self> {
        CommandProcess::spawn(command).map(Self::new)
    }
    pub fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.inner.take_stdin()
    }
    pub fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.inner.take_stdout()
    }
    pub fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.inner.take_stderr()
    }
    pub fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        self.inner.try_wait()
    }
    pub fn interrupt(&mut self) -> io::Result<()> {
        self.inner.interrupt()
    }
    pub fn resize(&mut self, size: ash_utils_pty::TerminalSize) -> io::Result<()> {
        self.inner.resize(size)
    }
    pub fn close(&mut self) -> io::Result<()> {
        self.inner.close()
    }
    pub(crate) fn with_backend(
        mut self,
        backend: Option<std::sync::Arc<dyn crate::SandboxBackend>>,
    ) -> Self {
        self.backend = backend;
        self
    }
    /// Only the implementation selected for this process may interpret its result.
    pub fn classify_denial(
        &self,
        status: SandboxProcessExitStatus,
        stdout: &str,
        stderr: &str,
    ) -> Option<crate::SandboxProcessDenial> {
        self.backend
            .as_ref()
            .and_then(|backend| backend.classify_denial(status, stdout, stderr))
    }
}
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = self.inner.close();
    }
}

use std::io;
use std::process::Command;

struct CommandProcess(ash_utils_process::OwnedChild);

impl CommandProcess {
    fn spawn(command: Command) -> io::Result<Self> {
        ash_utils_process::OwnedChild::spawn(command).map(Self)
    }
}

impl SandboxProcess for CommandProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.0.take_stdin().map(|stream| Box::new(stream) as _)
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.0.take_stdout().map(|stream| Box::new(stream) as _)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.0.take_stderr().map(|stream| Box::new(stream) as _)
    }
    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        self.0.try_wait().map(|status| {
            status.map(|status| {
                status.code().map_or(
                    SandboxProcessExitStatus::Terminated,
                    SandboxProcessExitStatus::Code,
                )
            })
        })
    }
    #[cfg(unix)]
    fn interrupt(&mut self) -> io::Result<()> {
        ash_utils_process::process_group::interrupt_process_group(self.0.id())
    }
    fn close(&mut self) -> io::Result<()> {
        self.0.close()
    }
}
#[cfg(all(test, unix))]
#[path = "process_tests.rs"]
mod tests;
