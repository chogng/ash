use portable_pty::Child;
use portable_pty::ChildKiller;
use portable_pty::CommandBuilder;
use portable_pty::ExitStatus;
use portable_pty::PtyPair;
use portable_pty::PtySize;
use portable_pty::PtySystem;
use portable_pty::SlavePty;
use std::io;
use std::os::windows::io::AsHandle;
use std::os::windows::io::RawHandle;
use std::sync::Arc;
use std::sync::Once;

mod job;

pub use job::JobObject;
pub use portable_pty::win::conpty_supported;
pub(crate) use portable_pty::win::supports_client_lifetime;

/// Adds Ash's process-tree policy to the shared PTY implementation.
#[derive(Default)]
pub(crate) struct ConPtySystem {}

impl PtySystem for ConPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        static TERMINAL_SIGNALS: Once = Once::new();
        TERMINAL_SIGNALS.call_once(|| {
            // Detached launchers pass an inherited "ignore Ctrl-C" attribute to
            // ConPTY clients. Restore Ctrl-C processing for future children;
            // this does not remove any of the host's registered signal handlers.
            // GUI/background hosts may have no console, so the return value is
            // not a console-availability check (node-pty uses the same reset).
            unsafe { winapi::um::consoleapi::SetConsoleCtrlHandler(None, 0) };
        });
        let mut pair = portable_pty::win::conpty::ConPtySystem::default().openpty(size)?;
        pair.slave = Box::new(JobSlave { inner: pair.slave });
        Ok(pair)
    }
}

struct JobSlave {
    inner: Box<dyn SlavePty + Send>,
}

impl SlavePty for JobSlave {
    fn spawn_command(
        &self,
        command: CommandBuilder,
    ) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let job = Arc::new(JobObject::create()?);
        let inner = self.inner.spawn_command_in_job(command, job.as_handle())?;
        Ok(Box::new(JobChild { inner, job }))
    }
}

#[derive(Debug)]
struct JobChild {
    inner: Box<dyn Child + Send + Sync>,
    job: Arc<JobObject>,
}

impl JobChild {
    fn preserve_descendants(&self) {
        if let Err(error) = self.job.preserve_descendants() {
            log::warn!("ConPTY failed to preserve descendants after root exit: {error}");
        }
    }
}

impl Child for JobChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.inner.try_wait()?;
        if status.is_some() {
            self.preserve_descendants();
        }
        Ok(status)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.inner.wait()?;
        self.preserve_descendants();
        Ok(status)
    }

    fn process_id(&self) -> Option<u32> {
        self.inner.process_id()
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        self.inner.as_raw_handle()
    }
}

impl ChildKiller for JobChild {
    fn kill(&mut self) -> io::Result<()> {
        JobKiller {
            job: Arc::clone(&self.job),
        }
        .kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(JobKiller {
            job: Arc::clone(&self.job),
        })
    }
}

#[derive(Debug)]
struct JobKiller {
    job: Arc<JobObject>,
}

impl ChildKiller for JobKiller {
    fn kill(&mut self) -> io::Result<()> {
        if let Err(error) = self.job.terminate() {
            log::warn!("ConPTY failed to terminate process tree: {error}");
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self {
            job: Arc::clone(&self.job),
        })
    }
}

/// A console prepared for a launcher that owns restricted process creation.
pub struct PreparedConPty {
    inner: portable_pty::win::conpty::PreparedConPty,
}

impl PreparedConPty {
    pub fn new(size: crate::TerminalSize) -> anyhow::Result<Self> {
        Ok(Self {
            inner: portable_pty::win::conpty::PreparedConPty::new(size.into())?,
        })
    }

    /// The launcher borrows this handle while this console remains alive.
    pub fn pseudoconsole_handle(&self) -> RawHandle {
        self.inner.pseudoconsole_handle()
    }

    /// Completes attachment after the external launcher has created its client.
    pub fn client_attached(&mut self) -> anyhow::Result<()> {
        self.inner.client_attached()
    }

    pub fn take_writer(&mut self) -> Option<Box<dyn std::io::Write + Send>> {
        self.inner.take_writer()
    }

    pub fn take_reader(&mut self) -> Option<Box<dyn std::io::Read + Send>> {
        self.inner.take_reader()
    }

    pub fn resize(&self, size: crate::TerminalSize) -> anyhow::Result<()> {
        self.inner.resize(size.into())
    }
}
