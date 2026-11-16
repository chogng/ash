//! Session ownership for pipe-backed processes, independent of their protocol and output policy.

use std::io;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;

/// Retains a process-tree identity until its descendants are stopped and the leader is reaped.
/// Callers own stream draining and graceful protocol shutdown before calling `close`.
pub struct OwnedChild {
    child: Child,
    #[cfg(unix)]
    _guard: Option<crate::process_guard::ProcessGuard>,
    #[cfg(windows)]
    job: crate::JobObject,
    closed: bool,
}

impl OwnedChild {
    pub fn spawn(mut command: Command) -> io::Result<Self> {
        #[cfg(unix)]
        crate::process_group::configure_command_session(&mut command);
        #[cfg(unix)]
        let guard = crate::process_guard::configure_command_guard(&mut command)?;
        #[cfg(windows)]
        let job = crate::JobObject::create()?;
        #[cfg(windows)]
        let child = job.spawn_contained_std(&mut command)?;
        #[cfg(not(windows))]
        let child = command.spawn()?;
        Ok(Self {
            child,
            #[cfg(unix)]
            _guard: guard,
            #[cfg(windows)]
            job,
            closed: false,
        })
    }

    /// Accesses the standard streams without handing off wait or kill ownership.
    pub fn take_stdin(&mut self) -> Option<std::process::ChildStdin> {
        self.child.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// A completed result includes tree cleanup, allowing inherited pipe writers to reach EOF.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.closed {
            return self.child.try_wait();
        }
        #[cfg(unix)]
        if !crate::process_group::child_has_exited(self.child.id())? {
            return Ok(None);
        }
        #[cfg(not(unix))]
        if self.child.try_wait()?.is_none() {
            return Ok(None);
        }
        self.close()?;
        self.child.try_wait()
    }

    pub fn close(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        #[cfg(unix)]
        let tree = crate::process_group::kill_process_session(self.child.id());
        #[cfg(windows)]
        let tree = self.job.terminate();
        #[cfg(not(any(unix, windows)))]
        let tree = Ok::<(), io::Error>(());
        let _ = self.child.kill();
        let reaped = self.child.wait();
        self.closed = reaped.is_ok();
        tree?;
        reaped?;
        Ok(())
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
