use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxLaunch;
use ash_sandboxing::SandboxProcess;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_sandboxing::SandboxScope;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;

pub(super) struct Launch {
    pub request: crate::request::Request,
    pub scope: SandboxScope,
    pub cwd: PathBuf,
    pub io: ash_sandboxing::ProcessIo,
}

impl SandboxLaunch for Launch {
    fn spawn(
        mut self: Box<Self>,
        environment: &[(String, String)],
    ) -> Result<ProcessHandle, SandboxError> {
        crate::policy::validate_paths(&self.cwd, &self.scope)?;
        self.request.set_env(environment);
        use mxc_sdk::mxc_common::sandbox_process::StdioMode;
        let stdio = match self.io {
            ash_sandboxing::ProcessIo::Pipes => StdioMode::Pipes,
            ash_sandboxing::ProcessIo::Pty(size) => StdioMode::Pty(pty_size(size)),
        };
        let mut inner = self.request.spawn(stdio)?;
        let (stdin, stdout, stderr) = if inner.is_pty() {
            // Claim each terminal stream once. The SDK retains lifecycle and resize control.
            let stdin = inner.pty_take_writer().map_err(stream_error)?;
            let stdout = inner.pty_clone_reader().map_err(stream_error)?;
            (
                Some(stdin),
                Some(stdout),
                Some(Box::new(io::empty()) as Box<dyn Read + Send>),
            )
        } else {
            (inner.take_stdin(), inner.take_stdout(), inner.take_stderr())
        };
        for warning in inner.warnings() {
            log::warn!(target: "sandbox", "MXC execution diagnostic: {warning}");
        }
        Ok(ProcessHandle::new(Process {
            inner,
            exit: None,
            closed: false,
            stdin,
            stdout,
            stderr,
        }))
    }
}

struct Process {
    inner: Box<dyn mxc_sdk::mxc_common::sandbox_process::SandboxProcess>,
    exit: Option<SandboxProcessExitStatus>,
    closed: bool,
    stdin: Option<Box<dyn Write + Send>>,
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
}
impl SandboxProcess for Process {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.stdin.take()
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout.take()
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stderr.take()
    }
    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        if let Some(exit) = self.exit {
            return Ok(Some(exit));
        }
        let status = self.inner.try_wait()?;
        if status.is_some() {
            self.close()?;
        }
        Ok(status.map(|code| {
            if code < 0 {
                SandboxProcessExitStatus::Terminated
            } else {
                SandboxProcessExitStatus::Code(code)
            }
        }))
    }
    fn interrupt(&mut self) -> io::Result<()> {
        self.inner.pty_interrupt()
    }
    fn resize(&mut self, size: ash_utils_pty::TerminalSize) -> io::Result<()> {
        self.inner.pty_resize(pty_size(size))
    }
    fn close(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        let killed = self.inner.kill();
        let waited = self.inner.wait();
        self.closed = waited.is_ok();
        killed?;
        self.exit = Some(match waited? {
            code if code >= 0 => SandboxProcessExitStatus::Code(code),
            _ => SandboxProcessExitStatus::Terminated,
        });
        Ok(())
    }
}

fn pty_size(size: ash_utils_pty::TerminalSize) -> mxc_sdk::mxc_common::sandbox_process::PtySize {
    mxc_sdk::mxc_common::sandbox_process::PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn stream_error(error: io::Error) -> SandboxError {
    SandboxError::StartFailed {
        timing: ash_sandboxing::SandboxDenialTiming::ProcessMayHaveStarted,
        message: error.to_string(),
    }
}
