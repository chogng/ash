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
        let prepared = self.request.prepare()?;
        let (inner, stdin, stdout, stderr) = match self.io {
            ash_sandboxing::ProcessIo::Pipes => {
                let mut child = prepared.spawn().map_err(crate::request::spawn_error)?;
                let streams = (child.take_stdin(), child.take_stdout(), child.take_stderr());
                (SdkProcess::Pipes(child), streams.0, streams.1, streams.2)
            }
            ash_sandboxing::ProcessIo::Pty(size) => {
                let child = prepared
                    .spawn_with_pty(pty_size(size))
                    .map_err(crate::request::spawn_error)?;
                let stdin = Some(child.take_writer().map_err(stream_error)?);
                let stdout = Some(child.try_clone_reader().map_err(stream_error)?);
                let stderr = Some(Box::new(io::empty()) as Box<dyn Read + Send>);
                (SdkProcess::Pty(child), stdin, stdout, stderr)
            }
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

enum SdkProcess {
    Pipes(mxc_sdk::v1::MxcProcess),
    Pty(mxc_sdk::v1::MxcPtyProcess),
}
impl SdkProcess {
    fn warnings(&self) -> Vec<String> {
        match self {
            Self::Pipes(child) => child.warnings(),
            Self::Pty(child) => child.warnings(),
        }
    }
    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        match self {
            Self::Pipes(child) => child.try_wait(),
            Self::Pty(child) => child.try_wait(),
        }
    }
    fn kill(&mut self) -> io::Result<()> {
        match self {
            Self::Pipes(child) => child.kill(),
            Self::Pty(child) => child.kill(),
        }
    }
    fn wait(&mut self) -> io::Result<mxc_sdk::v1::WaitResult> {
        match self {
            Self::Pipes(child) => child.wait(),
            Self::Pty(child) => child.wait(),
        }
    }
    fn interrupt(&self) -> io::Result<()> {
        match self {
            Self::Pty(child) => child.interrupt(),
            Self::Pipes(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "process has no terminal",
            )),
        }
    }
    fn resize(&self, size: mxc_sdk::v1::MxcPtySize) -> io::Result<()> {
        match self {
            Self::Pty(child) => child.resize(size),
            Self::Pipes(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "process has no terminal",
            )),
        }
    }
}

struct Process {
    inner: SdkProcess,
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
        self.inner.interrupt()
    }
    fn resize(&mut self, size: ash_utils_pty::TerminalSize) -> io::Result<()> {
        self.inner.resize(pty_size(size))
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
            mxc_sdk::v1::WaitResult::Exited(code) if code >= 0 => {
                SandboxProcessExitStatus::Code(code)
            }
            _ => SandboxProcessExitStatus::Terminated,
        });
        Ok(())
    }
}

fn pty_size(size: ash_utils_pty::TerminalSize) -> mxc_sdk::v1::MxcPtySize {
    mxc_sdk::v1::MxcPtySize {
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
