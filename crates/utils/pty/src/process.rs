use core::fmt;
use std::io;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;

use anyhow::anyhow;
use portable_pty::MasterPty;
use portable_pty::PtySize;
use portable_pty::SlavePty;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessSignal {
    Interrupt,
    Terminate,
    Kill,
    Hangup,
}

impl ProcessSignal {
    #[cfg(unix)]
    pub(crate) fn unix_number(self) -> libc::c_int {
        match self {
            Self::Interrupt => libc::SIGINT,
            Self::Terminate => libc::SIGTERM,
            Self::Kill => libc::SIGKILL,
            Self::Hangup => libc::SIGHUP,
        }
    }
}

pub(crate) fn unsupported_signal(signal: ProcessSignal) -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        format!("process signal {signal:?} is not supported by this process backend"),
    )
}

pub(crate) trait ChildTerminator: Send + Sync {
    fn signal(&mut self, signal: ProcessSignal) -> io::Result<()>;

    fn kill(&mut self) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self { rows: 24, cols: 80 }
    }
}

impl From<TerminalSize> for PtySize {
    fn from(value: TerminalSize) -> Self {
        Self {
            rows: value.rows,
            cols: value.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

pub struct PtyHandles {
    pub _slave: Option<Box<dyn SlavePty + Send>>,
    pub(crate) _master: Box<dyn MasterPty + Send>,
}

impl fmt::Debug for PtyHandles {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PtyHandles").finish()
    }
}

/// Handle for driving an interactive process (PTY or pipe).
pub struct ProcessHandle {
    process_id: Option<u32>,
    writer_tx: StdMutex<Option<mpsc::Sender<Vec<u8>>>>,
    killer: StdMutex<Option<Box<dyn ChildTerminator>>>,
    reader_handle: StdMutex<Option<JoinHandle<()>>>,
    writer_handle: StdMutex<Option<JoinHandle<()>>>,
    wait_handle: StdMutex<Option<JoinHandle<()>>>,
    exit_status: Arc<AtomicBool>,
    exit_code: Arc<StdMutex<Option<i32>>>,
    // PtyHandles must be preserved because the process will receive Control+C if the
    // slave is closed
    _pty_handles: StdMutex<Option<PtyHandles>>,
}

impl fmt::Debug for ProcessHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProcessHandle").finish()
    }
}

impl ProcessHandle {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        process_id: Option<u32>,
        writer_tx: mpsc::Sender<Vec<u8>>,
        killer: Box<dyn ChildTerminator>,
        reader_handle: JoinHandle<()>,
        writer_handle: JoinHandle<()>,
        wait_handle: JoinHandle<()>,
        exit_status: Arc<AtomicBool>,
        exit_code: Arc<StdMutex<Option<i32>>>,
        pty_handles: Option<PtyHandles>,
    ) -> Self {
        Self {
            process_id,
            writer_tx: StdMutex::new(Some(writer_tx)),
            killer: StdMutex::new(Some(killer)),
            reader_handle: StdMutex::new(Some(reader_handle)),
            writer_handle: StdMutex::new(Some(writer_handle)),
            wait_handle: StdMutex::new(Some(wait_handle)),
            exit_status,
            exit_code,
            _pty_handles: StdMutex::new(pty_handles),
        }
    }

    /// OS identity captured at spawn, before the child is moved into its reaper.
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Queries the OS process tree at the point of a destructive user action.
    /// Unknown identity is distinct from an idle shell; callers can protect it conservatively.
    pub fn has_child_processes(&self) -> Option<bool> {
        if self.has_exited() {
            return Some(false);
        }
        let pid = sysinfo::Pid::from_u32(self.process_id?);
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system.process(pid)?;
        Some(
            system
                .processes()
                .values()
                .any(|child| child.parent() == Some(pid)),
        )
    }

    /// Queries the root child's current directory, without substituting its launch directory.
    /// A platform without a process-directory API, or an exited child, returns `None`.
    pub fn current_working_directory(&self) -> io::Result<Option<std::path::PathBuf>> {
        if self.has_exited() {
            return Ok(None);
        }
        let Some(process_id) = self.process_id else {
            return Ok(None);
        };
        process_working_directory(process_id)
    }

    /// Returns a channel sender for writing raw bytes to the child stdin.
    pub fn writer_sender(&self) -> mpsc::Sender<Vec<u8>> {
        if let Ok(writer_tx) = self.writer_tx.lock()
            && let Some(writer_tx) = writer_tx.as_ref()
        {
            return writer_tx.clone();
        }

        let (writer_tx, writer_rx) = mpsc::channel(1);
        drop(writer_rx);
        writer_tx
    }

    /// True if the child process has exited.
    pub fn has_exited(&self) -> bool {
        self.exit_status.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Returns the exit code if known.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code.lock().ok().and_then(|guard| *guard)
    }

    /// Releases parent-held PTY handles after the child has authoritatively exited.
    ///
    /// Windows with `ReleasePseudoConsole` closes output after its last client exits,
    /// so the console handle remains owned by this session until disposal. On older
    /// Windows, releasing the console after root exit lets readers drain and observe EOF.
    pub fn release_pty_handles_after_exit(&self) {
        if !self.has_exited() {
            return;
        }
        // Newer Windows closes output when the last console client exits.
        // Closing HPCON on root exit would terminate surviving descendants.
        #[cfg(windows)]
        if crate::win::supports_client_lifetime() {
            return;
        }
        if let Ok(mut handles) = self._pty_handles.lock() {
            handles.take();
        }
    }

    /// Resize the PTY in character cells.
    pub fn resize(&self, size: TerminalSize) -> anyhow::Result<()> {
        {
            let handles = self
                ._pty_handles
                .lock()
                .map_err(|_| anyhow!("failed to lock PTY handles"))?;
            if let Some(handles) = handles.as_ref() {
                return handles._master.resize(size.into());
            }
        }

        Err(anyhow!("process is not attached to a PTY"))
    }

    /// Close the child's stdin channel.
    pub fn close_stdin(&self) {
        if let Ok(mut writer_tx) = self.writer_tx.lock() {
            writer_tx.take();
        }
    }

    /// Attempts to kill the child while leaving the reader/writer tasks alive
    /// so callers can still drain output until EOF.
    pub fn request_terminate(&self) {
        if let Ok(mut killer_opt) = self.killer.lock()
            && let Some(mut killer) = killer_opt.take()
        {
            let _ = killer.kill();
        }
    }

    pub fn signal(&self, signal: ProcessSignal) -> io::Result<()> {
        #[cfg(unix)]
        {
            let handles = self
                ._pty_handles
                .lock()
                .map_err(|_| io::Error::other("PTY handle lock poisoned"))?;
            if let Some(handles) = handles.as_ref() {
                let fd = handles
                    ._master
                    .as_raw_fd()
                    .ok_or_else(|| unsupported_signal(signal))?;
                // Interactive shells move each foreground job to a separate group. The
                // PTY, rather than the shell's cached group, identifies the current target.
                let group = unsafe { libc::tcgetpgrp(fd) };
                if group <= 0 {
                    return Err(io::Error::last_os_error());
                }
                let number = signal.unix_number();
                if unsafe { libc::kill(-group, number) } == -1 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
        }
        let Ok(mut killer_opt) = self.killer.lock() else {
            return Ok(());
        };
        let Some(killer) = killer_opt.as_mut() else {
            return Ok(());
        };

        killer.signal(signal)
    }

    /// Kills the child and cancels I/O while its waiter completes reaping and reports exit.
    pub fn terminate(&self) {
        self.request_terminate();

        if let Ok(mut h) = self.reader_handle.lock()
            && let Some(handle) = h.take()
        {
            handle.abort();
        }
        if let Ok(mut h) = self.writer_handle.lock()
            && let Some(handle) = h.take()
        {
            handle.abort();
        }
        if let Ok(mut h) = self.wait_handle.lock()
            && let Some(handle) = h.take()
        {
            // A queued blocking waiter must still run to reap the terminated child.
            drop(handle);
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(target_os = "linux")]
fn process_working_directory(process_id: u32) -> io::Result<Option<std::path::PathBuf>> {
    std::fs::read_link(format!("/proc/{process_id}/cwd")).map(Some)
}

#[cfg(target_os = "macos")]
fn process_working_directory(process_id: u32) -> io::Result<Option<std::path::PathBuf>> {
    use std::os::unix::ffi::OsStringExt;
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>();
    // proc_pidinfo writes this fixed-size structure only on a complete successful query.
    let written = unsafe {
        libc::proc_pidinfo(
            process_id as i32,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if written != size as i32 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    let bytes = info
        .pvi_cdir
        .vip_path
        .into_iter()
        .flatten()
        .take_while(|byte| *byte != 0)
        .map(|byte| byte as u8)
        .collect();
    Ok(Some(std::ffi::OsString::from_vec(bytes).into()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_working_directory(_process_id: u32) -> io::Result<Option<std::path::PathBuf>> {
    Ok(None)
}

/// A PTY process and its input, output, and exit channels.
#[derive(Debug)]
pub struct SpawnedProcess {
    pub session: ProcessHandle,
    pub stdout_rx: mpsc::Receiver<Vec<u8>>,
    pub stderr_rx: mpsc::Receiver<Vec<u8>>,
    pub exit_rx: oneshot::Receiver<i32>,
}
