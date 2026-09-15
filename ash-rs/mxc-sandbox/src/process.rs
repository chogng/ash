use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxDenialTiming;
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
    pub request: mxc_sdk::SandboxRequest,
    pub scope: SandboxScope,
    pub cwd: PathBuf,
}

impl SandboxLaunch for Launch {
    fn spawn(
        mut self: Box<Self>,
        environment: &[(String, String)],
    ) -> Result<ProcessHandle, SandboxError> {
        crate::policy::validate_paths(&self.cwd, &self.scope)?;
        self.request.set_env(environment.iter().cloned());
        let inner =
            mxc_sdk::spawn_sandbox(self.request).map_err(|error| SandboxError::StartFailed {
                timing: SandboxDenialTiming::ProcessMayHaveStarted,
                message: error.to_string(),
            })?;
        for warning in inner.warnings() {
            log::warn!(target: "sandbox", "MXC execution diagnostic: {warning}");
        }
        Ok(ProcessHandle::new(Process {
            inner,
            exit: None,
            closed: false,
        }))
    }
}

struct Process {
    inner: mxc_sdk::Sandbox,
    exit: Option<SandboxProcessExitStatus>,
    closed: bool,
}
impl SandboxProcess for Process {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.inner.take_stdin()
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.inner.take_stdout()
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.inner.take_stderr()
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
    fn close(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        let killed = self.inner.kill();
        let waited = self.inner.wait();
        self.closed = waited.is_ok();
        killed?;
        self.exit = Some(match waited? {
            mxc_sdk::WaitOutcome::Exited(code) if code >= 0 => SandboxProcessExitStatus::Code(code),
            _ => SandboxProcessExitStatus::Terminated,
        });
        Ok(())
    }
}
