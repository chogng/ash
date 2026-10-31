use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::IntoRawHandle;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mio::windows::NamedPipe;
use sha2::Digest;
use sha2::Sha256;
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_FIRST_PIPE_INSTANCE;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
use windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT;
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::Pipes::CreateNamedPipeW;
use windows_sys::Win32::System::Pipes::PIPE_READMODE_MESSAGE;
use windows_sys::Win32::System::Pipes::PIPE_REJECT_REMOTE_CLIENTS;
use windows_sys::Win32::System::Pipes::PIPE_TYPE_MESSAGE;
use windows_sys::Win32::System::Pipes::PIPE_UNLIMITED_INSTANCES;
use windows_sys::Win32::System::Pipes::SetNamedPipeHandleState;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

use super::reactor;
use super::reactor::Registration;
use super::security::PrivateSecurity;
use super::security::SecuredObject;

#[derive(Clone, Copy, Debug)]
pub(super) enum Side {
    Server,
    Client,
}

struct Connection {
    pipe: Mutex<Option<NamedPipe>>,
    registration: Registration,
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
        let file = loop {
            match OpenOptions::new()
                .read(true)
                .write(true)
                // A discovered server must never be able to impersonate this client.
                .custom_flags(
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                )
                .open(name)
            {
                Ok(file) => break file,
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    // A full accept backlog is a live listener, not a missing daemon.
                    // Wait for an instance and retry: another client can claim it first.
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
        let mode = PIPE_READMODE_MESSAGE;
        if unsafe {
            SetNamedPipeHandleState(
                file.as_raw_handle() as _,
                &mode,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // Ownership transfers to Mio, which retains overlapped buffers until completion.
        let mut pipe = unsafe { NamedPipe::from_raw_handle(file.into_raw_handle()) };
        let registration = reactor::register(&mut pipe)?;
        Ok(Self::from_registered(pipe, registration, Side::Client))
    }

    fn from_registered(pipe: NamedPipe, registration: Registration, side: Side) -> Self {
        Self(Arc::new(Connection {
            pipe: Mutex::new(Some(pipe)),
            registration,
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
                return self.operate(Direction::Write, |mut pipe| {
                    if self.0.output_eof.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    pipe.write(&[])?;
                    self.0.output_eof.store(true, Ordering::Release);
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
        self.0.registration.ready.lock().unwrap().closed = true;
        if let Some(pipe) = pipe.take() {
            // Explicit shutdown aborts outstanding IO across all clones. Ordinary drop lets
            // Mio finish queued writes, preserving bytes already accepted by Write.
            unsafe { CancelIoEx(pipe.as_raw_handle() as _, std::ptr::null()) };
        }
        self.0.registration.ready.notify();
        reactor::notify();
        Ok(())
    }

    pub(super) fn peer_identity(&self) -> io::Result<crate::PeerIdentity> {
        let pipe = self.0.pipe.lock().unwrap();
        let pipe = pipe.as_ref().ok_or_else(closed)?;
        super::peer::peer_identity(pipe.as_raw_handle() as _, self.0.side)
    }

    pub(super) fn ready(&self, direction: Direction) -> bool {
        let ready = self.0.registration.ready.lock().unwrap();
        ready.closed
            || match direction {
                Direction::Read => ready.readable || self.0.input_eof.load(Ordering::Acquire),
                Direction::Write => ready.writable || self.0.output_eof.load(Ordering::Acquire),
            }
    }

    fn operate<T>(
        &self,
        direction: Direction,
        mut operation: impl FnMut(&NamedPipe) -> io::Result<T>,
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
                // Clear readiness while holding its lock so a completion cannot be lost
                // between a WouldBlock result and the following wait.
                let mut ready = self.0.registration.ready.lock().unwrap();
                if ready.closed {
                    return Err(closed());
                }
                match operation(pipe) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        match direction {
                            Direction::Read => ready.readable = false,
                            Direction::Write => ready.writable = false,
                        }
                        if self.0.nonblocking.load(Ordering::Acquire) {
                            return Err(error);
                        }
                    }
                    result => return result,
                }
            }
            let remaining = timeout.map(|timeout| timeout.saturating_sub(started.elapsed()));
            self.0
                .registration
                .ready
                .wait(remaining, |ready| match direction {
                    Direction::Read => ready.readable,
                    Direction::Write => ready.writable,
                })?;
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
        let result = self.operate(Direction::Read, |mut pipe| {
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
            self.0.registration.ready.notify();
            reactor::notify();
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
        self.operate(Direction::Write, |mut pipe| {
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

struct Pending {
    pipe: NamedPipe,
    registration: Registration,
}

pub struct IpcListener {
    name: String,
    pending: Mutex<Vec<Pending>>,
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

    pub(super) fn ready(&self) -> bool {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .any(|pending| pending.registration.ready.lock().unwrap().writable)
    }

    pub fn accept(&self) -> io::Result<(IpcStream, ())> {
        loop {
            {
                let mut pending = self.pending.lock().unwrap();
                if let Some(index) = pending
                    .iter()
                    .position(|pending| pending.registration.ready.lock().unwrap().writable)
                {
                    if let Some(error) = pending[index].pipe.take_error()? {
                        return Err(error);
                    }
                    // Claim the replacement before handing off this handle: the namespace
                    // must stay owned even when the last accepted connection closes.
                    let next = create_instance(&self.name, Instance::Additional)?;
                    let connected = std::mem::replace(&mut pending[index], next);
                    return Ok((
                        IpcStream::from_registered(
                            connected.pipe,
                            connected.registration,
                            Side::Server,
                        ),
                        (),
                    ));
                }
                if self.nonblocking.load(Ordering::Acquire) {
                    return Err(io::ErrorKind::WouldBlock.into());
                }
            }
            reactor::wait(None, || self.ready())?;
        }
    }
}

enum Instance {
    First,
    Additional,
}

fn create_instance(name: &str, instance: Instance) -> io::Result<Pending> {
    let security = PrivateSecurity::new(SecuredObject::Pipe)?;
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let flags = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | match instance {
            Instance::First => FILE_FLAG_FIRST_PIPE_INSTANCE,
            Instance::Additional => 0,
        };
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            flags,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &security.attributes(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut pipe = unsafe { NamedPipe::from_raw_handle(handle as _) };
    let registration = reactor::register(&mut pipe)?;
    match pipe.connect() {
        Ok(()) => registration.ready.lock().unwrap().writable = true,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        Err(error) => return Err(error),
    }
    Ok(Pending { pipe, registration })
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
