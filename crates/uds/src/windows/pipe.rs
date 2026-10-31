use std::io;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use futures::FutureExt;
use futures::future::select_all;
use sha2::Digest;
use sha2::Sha256;
use tokio::io::Interest;
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::net::windows::named_pipe::PipeMode;
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::Notify;
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

use super::readiness;
use super::security::PrivateSecurity;
use super::security::SecuredObject;

#[derive(Clone, Copy, Debug)]
pub(super) enum Side {
    Server,
    Client,
}

enum Pipe {
    Server(Arc<NamedPipeServer>),
    Client(NamedPipeClient),
}

impl Pipe {
    fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Server(pipe) => pipe.try_read(buffer),
            Self::Client(pipe) => pipe.try_read(buffer),
        }
    }

    fn write(&self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Server(pipe) => pipe.try_write(buffer),
            Self::Client(pipe) => pipe.try_write(buffer),
        }
    }

    async fn ready(&self, interest: Interest) -> io::Result<()> {
        match self {
            Self::Server(pipe) => pipe.ready(interest).await?,
            Self::Client(pipe) => pipe.ready(interest).await?,
        };
        Ok(())
    }

    fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
        match self {
            Self::Server(pipe) => pipe.as_raw_handle(),
            Self::Client(pipe) => pipe.as_raw_handle(),
        }
    }
}

struct Connection {
    pipe: Mutex<Option<Arc<Pipe>>>,
    changed: Notify,
    side: Side,
    input_eof: AtomicBool,
    output_eof: AtomicBool,
    nonblocking: AtomicBool,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
}

/// A byte stream over a local, user-only Windows named pipe. Clones share close and mode state.
pub struct IpcStream(Arc<Connection>);

impl std::fmt::Debug for IpcStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IpcStream")
            .field("side", &self.0.side)
            .finish_non_exhaustive()
    }
}

impl IpcStream {
    pub fn connect(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::connect_name(&pipe_name(path.as_ref())?)
    }

    fn connect_name(name: &str) -> io::Result<Self> {
        let deadline = Instant::now() + Duration::from_secs(1);
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let _runtime = readiness::enter()?;
        let pipe = loop {
            match ClientOptions::new()
                .pipe_mode(PipeMode::Message)
                // A discovered server must never be able to impersonate this client.
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(name)
            {
                Ok(pipe) => break pipe,
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    // A full accept backlog is a live listener, not a missing daemon.
                    let remaining =
                        deadline
                            .checked_duration_since(Instant::now())
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "local pipe accept backlog is full",
                                )
                            })?;
                    let milliseconds =
                        u32::try_from(remaining.as_millis().max(1)).unwrap_or(u32::MAX - 1);
                    if unsafe { WaitNamedPipeW(wide.as_ptr(), milliseconds) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Err(error) => return Err(error),
            }
        };
        Ok(Self::from_pipe(Pipe::Client(pipe), Side::Client))
    }

    fn from_pipe(pipe: Pipe, side: Side) -> Self {
        Self(Arc::new(Connection {
            pipe: Mutex::new(Some(Arc::new(pipe))),
            changed: Notify::new(),
            side,
            input_eof: AtomicBool::new(false),
            output_eof: AtomicBool::new(false),
            nonblocking: AtomicBool::new(false),
            read_timeout: Mutex::new(None),
            write_timeout: Mutex::new(None),
        }))
    }

    pub fn pair() -> io::Result<(Self, Self)> {
        static NEXT_PAIR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let name = format!(
            r"\\.\pipe\ash-ipc-pair-{}-{}",
            std::process::id(),
            NEXT_PAIR.fetch_add(1, Ordering::Relaxed)
        );
        let listener = IpcListener::bind_name(name)?;
        let client = Self::connect_name(&listener.name)?;
        let (server, ()) = listener.accept()?;
        Ok((client, server))
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(self.0.clone()))
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.0.nonblocking.store(nonblocking, Ordering::Release);
        Ok(())
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        set_timeout(&self.0.read_timeout, timeout)
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        set_timeout(&self.0.write_timeout, timeout)
    }

    /// Message boundaries stay internal to this byte-stream adapter. An empty message marks
    /// input EOF without closing the reverse direction, preserving finite stdio responses.
    pub fn shutdown(&self, direction: Shutdown) -> io::Result<()> {
        match direction {
            Shutdown::Write => {
                return self.operate(Direction::Write, |pipe| {
                    if self.0.output_eof.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    pipe.write(&[])?;
                    self.0.output_eof.store(true, Ordering::Release);
                    self.0.changed.notify_waiters();
                    Ok(())
                });
            }
            Shutdown::Read => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "local named pipes do not support read shutdown",
                ));
            }
            Shutdown::Both => {}
        }
        let mut pipe = self.0.pipe.lock().unwrap();
        if let Some(pipe) = pipe.take() {
            // Explicit shutdown aborts outstanding IO across all clones. Ordinary drop lets
            // Tokio/Mio finish queued writes, preserving bytes already accepted by Write.
            unsafe { CancelIoEx(pipe.as_raw_handle() as _, std::ptr::null()) };
        }
        self.0.changed.notify_waiters();
        Ok(())
    }

    pub(super) fn peer_identity(&self) -> io::Result<crate::PeerIdentity> {
        let pipe = self.0.pipe.lock().unwrap();
        let pipe = pipe.as_ref().ok_or_else(closed)?;
        super::peer::peer_identity(pipe.as_raw_handle() as _, self.0.side)
    }

    pub(super) async fn ready(&self, direction: Direction) -> io::Result<()> {
        // Create the notification before inspecting state so shutdown/EOF cannot be lost
        // between the check and registering the pipe's readiness future.
        let changed = self.0.changed.notified();
        let pipe = self.0.pipe.lock().unwrap().clone();
        let Some(pipe) = pipe else { return Ok(()) };
        let eof = match direction {
            Direction::Read => self.0.input_eof.load(Ordering::Acquire),
            Direction::Write => self.0.output_eof.load(Ordering::Acquire),
        };
        if eof {
            return Ok(());
        }
        let interest = match direction {
            Direction::Read => Interest::READABLE,
            Direction::Write => Interest::WRITABLE,
        };
        tokio::select! {
            result = pipe.ready(interest) => result,
            _ = changed => Ok(()),
        }
    }

    fn operate<T>(
        &self,
        direction: Direction,
        mut operation: impl FnMut(&Pipe) -> io::Result<T>,
    ) -> io::Result<T> {
        let timeout = match direction {
            Direction::Read => *self.0.read_timeout.lock().unwrap(),
            Direction::Write => *self.0.write_timeout.lock().unwrap(),
        };
        let started = Instant::now();
        loop {
            {
                let pipe = self.0.pipe.lock().unwrap();
                let pipe = pipe.as_ref().ok_or_else(closed)?;
                match operation(pipe) {
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && !self.0.nonblocking.load(Ordering::Acquire) => {}
                    result => return result,
                }
            }
            let remaining = timeout.map(|timeout| timeout.saturating_sub(started.elapsed()));
            readiness::wait(self.ready(direction), remaining)?;
        }
    }
}

impl Read for IpcStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buffer)
    }
}

impl Read for &IpcStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let result = self.operate(Direction::Read, |pipe| {
            if self.0.input_eof.load(Ordering::Acquire) {
                return Ok(0);
            }
            let count = pipe.read(buffer)?;
            if count == 0 {
                self.0.input_eof.store(true, Ordering::Release);
            }
            Ok(count)
        });
        if matches!(result, Ok(0)) {
            self.0.changed.notify_waiters();
        }
        result
    }
}

impl Write for IpcStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        (&*self).write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Write for &IpcStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        // Bound the one in-flight write, preserving kernel backpressure for large frames.
        self.operate(Direction::Write, |pipe| {
            if self.0.output_eof.load(Ordering::Acquire) {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            pipe.write(&buffer[..buffer.len().min(64 * 1024)])
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(super) enum Direction {
    Read,
    Write,
}

pub struct IpcListener {
    name: String,
    pending: Mutex<Vec<Arc<NamedPipeServer>>>,
    nonblocking: AtomicBool,
}

impl IpcListener {
    pub fn bind(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::bind_name(pipe_name(path.as_ref())?)
    }

    fn bind_name(name: String) -> io::Result<Self> {
        let mut pending = vec![create_instance(&name, Instance::First)?];
        // Keep a small accept backlog so simultaneous Desktop windows can connect before
        // the lifecycle loop consumes its next IOCP completion.
        for _ in 1..4 {
            pending.push(create_instance(&name, Instance::Additional)?);
        }
        Ok(Self {
            pending: Mutex::new(pending),
            name,
            nonblocking: AtomicBool::new(false),
        })
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.nonblocking.store(nonblocking, Ordering::Release);
        Ok(())
    }

    pub(super) async fn ready(&self) -> io::Result<()> {
        let pending = self.pending.lock().unwrap().clone();
        select_all(pending.iter().map(|pipe| Box::pin(pipe.connect())))
            .await
            .0
    }

    pub fn accept(&self) -> io::Result<(IpcStream, ())> {
        let _runtime = readiness::enter()?;
        loop {
            {
                let mut pending = self.pending.lock().unwrap();
                for index in 0..pending.len() {
                    if let Some(result) = pending[index].connect().now_or_never() {
                        result?;
                        // Replace before handing off the connected instance, keeping the
                        // namespace owned even when the last accepted connection closes.
                        let next = create_instance(&self.name, Instance::Additional)?;
                        let connected = std::mem::replace(&mut pending[index], next);
                        return Ok((
                            IpcStream::from_pipe(Pipe::Server(connected), Side::Server),
                            (),
                        ));
                    }
                }
                if self.nonblocking.load(Ordering::Acquire) {
                    return Err(io::ErrorKind::WouldBlock.into());
                }
            }
            readiness::wait(self.ready(), None)?;
        }
    }
}

enum Instance {
    First,
    Additional,
}

fn create_instance(name: &str, instance: Instance) -> io::Result<Arc<NamedPipeServer>> {
    let security = PrivateSecurity::new(SecuredObject::Pipe)?;
    let mut attributes = security.attributes();
    let _runtime = readiness::enter()?;
    // The user-only security descriptor and attributes outlive this synchronous create call.
    let pipe = unsafe {
        ServerOptions::new()
            .first_pipe_instance(matches!(instance, Instance::First))
            .pipe_mode(PipeMode::Message)
            .reject_remote_clients(true)
            .in_buffer_size(64 * 1024)
            .out_buffer_size(64 * 1024)
            .create_with_security_attributes_raw(name, std::ptr::addr_of_mut!(attributes).cast())?
    };
    Ok(Arc::new(pipe))
}

/// The filesystem path is only a rendezvous identity. Its depth never enters the pipe name.
pub(crate) fn pipe_name(path: &Path) -> io::Result<String> {
    let absolute = std::path::absolute(path)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint has no parent"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint has no name"))?;
    let identity = std::fs::canonicalize(parent)?.join(name);
    let mut digest = Sha256::new();
    digest.update(b"ash-windows-local-ipc-v1\0");
    for unit in identity.as_os_str().encode_wide() {
        if unit == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "endpoint contains NUL",
            ));
        }
        digest.update(unit.to_le_bytes());
    }
    Ok(format!(r"\\.\pipe\ash-ipc-{:x}", digest.finalize()))
}

fn set_timeout(target: &Mutex<Option<Duration>>, timeout: Option<Duration>) -> io::Result<()> {
    if timeout.is_some_and(|timeout| timeout.is_zero()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "IPC timeout must be nonzero",
        ));
    }
    *target.lock().unwrap() = timeout;
    Ok(())
}

fn closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "local IPC connection is closed",
    )
}

#[cfg(test)]
#[path = "pipe_tests.rs"]
mod tests;
