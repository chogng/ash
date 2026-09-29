use std::collections::BTreeMap;
use std::io;
use std::io::Read;
use std::net::Shutdown;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use ash_uds::UnixListener;
use ash_uds::UnixStream;

/// One half of an established local RPC connection, sharing its input-end lifetime.
///
/// IO waits remain interruptible: EOF on the reader ends queued output even when the peer keeps
/// its read half open without consuming data. Finite stdio transports do not use this contract.
pub struct LocalStream {
    stream: UnixStream,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl LocalStream {
    /// Splits a validated socket into reader and writer with one connection-close signal.
    pub fn pair(stream: UnixStream) -> io::Result<(Self, Self)> {
        #[cfg(unix)]
        stream.set_nonblocking(true)?;
        #[cfg(windows)]
        {
            stream.set_nonblocking(false)?;
            stream.set_read_timeout(Some(std::time::Duration::from_millis(25)))?;
            stream.set_write_timeout(Some(std::time::Duration::from_millis(25)))?;
        }
        let writer = stream.try_clone()?;
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        Ok((
            Self {
                stream,
                closed: Arc::clone(&closed),
            },
            Self {
                stream: writer,
                closed,
            },
        ))
    }

    /// Clones the socket solely for the process owner's shutdown registration.
    pub fn try_clone(&self) -> io::Result<UnixStream> {
        self.stream.try_clone()
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    fn ensure_open(&self) -> io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(io::Error::from(io::ErrorKind::ConnectionAborted))
        } else {
            Ok(())
        }
    }

    #[cfg(unix)]
    fn wait(&self, events: rustix::event::PollFlags) -> io::Result<()> {
        let mut descriptor = rustix::event::PollFd::new(&self.stream, events);
        let timeout = rustix::event::Timespec::try_from(std::time::Duration::from_millis(25))
            .expect("fixed poll duration");
        match rustix::event::poll(std::slice::from_mut(&mut descriptor), Some(&timeout)) {
            Ok(_) | Err(rustix::io::Errno::INTR) => Ok(()),
            Err(error) => Err(io::Error::from(error)),
        }
    }
}

impl Read for LocalStream {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            self.ensure_open()?;
            match self.stream.read(output) {
                Ok(0) => {
                    self.close();
                    return Ok(0);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    #[cfg(unix)]
                    self.wait(rustix::event::PollFlags::IN)?;
                }
                Err(error) => {
                    self.close();
                    return Err(error);
                }
                result => return result,
            }
        }
    }
}

impl std::io::Write for LocalStream {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        loop {
            self.ensure_open()?;
            match self.stream.write(input) {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    #[cfg(unix)]
                    self.wait(rustix::event::PollFlags::OUT)?;
                }
                Err(error) => {
                    self.close();
                    return Err(error);
                }
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.ensure_open()
    }
}

/// One result from polling a local App Server listener.
pub enum LocalSocketAccept {
    /// No connection is currently ready.
    Pending,
    /// A connection was accepted and normalized for blocking request processing.
    Accepted(UnixStream),
    /// A connection was accepted but could not be normalized for request processing.
    Rejected(io::Error),
}

/// A non-blocking local listener that returns blocking accepted connections.
///
/// The listener is polled by a lifecycle owner, while every accepted stream is
/// normalized before a synchronous protocol reader receives it. This distinction
/// is required on platforms where accepted streams inherit the listener mode.
pub struct PollingLocalListener {
    listener: UnixListener,
}

impl PollingLocalListener {
    /// Configures an existing listener for polling.
    pub fn new(listener: UnixListener) -> io::Result<Self> {
        listener.set_nonblocking(true)?;
        Ok(Self { listener })
    }

    /// Polls for one normalized connection.
    pub fn poll_accept(&self) -> io::Result<LocalSocketAccept> {
        match self.listener.accept() {
            Ok((stream, _address)) => match stream.set_nonblocking(false) {
                Ok(()) => match validate_local_peer(&stream) {
                    Ok(()) => Ok(LocalSocketAccept::Accepted(stream)),
                    Err(error) => Ok(LocalSocketAccept::Rejected(error)),
                },
                Err(error) => Ok(LocalSocketAccept::Rejected(error)),
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                Ok(LocalSocketAccept::Pending)
            }
            Err(error) => Err(error),
        }
    }
}

/// Local App Server connections may not cross user or Windows elevation boundaries.
/// Call before sending initialization data or starting a protocol reader.
pub fn validate_local_peer(stream: &UnixStream) -> io::Result<()> {
    validate_local_identity(ash_uds::peer_identity(stream)?)
}

fn validate_local_identity(peer: ash_uds::PeerIdentity) -> io::Result<()> {
    if peer.same_user && peer.same_elevation {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "local App Server peer has a different user or elevation context",
        ))
    }
}

/// Tracks the local connections owned by one App Server process generation.
pub struct LocalConnections {
    next_id: AtomicU64,
    count: AtomicUsize,
    streams: Mutex<BTreeMap<u64, UnixStream>>,
}

impl LocalConnections {
    /// Creates an empty connection set.
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            count: AtomicUsize::new(0),
            streams: Mutex::new(BTreeMap::new()),
        }
    }

    /// Returns the number of connections whose guards are still alive.
    pub fn len(&self) -> usize {
        self.count.load(Ordering::Acquire)
    }

    /// Returns whether no connection guards are alive.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Registers a connection shutdown handle and returns its lifetime guard.
    pub fn register(
        self: &Arc<Self>,
        shutdown_stream: UnixStream,
    ) -> io::Result<LocalConnectionGuard> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.streams
            .lock()
            .map_err(|_| io::Error::other("local connection lock poisoned"))?
            .insert(id, shutdown_stream);
        self.count.fetch_add(1, Ordering::AcqRel);
        Ok(LocalConnectionGuard {
            connections: Arc::clone(self),
            id,
        })
    }

    /// Shuts down every currently registered connection.
    pub fn shutdown_all(&self) {
        if let Ok(streams) = self.streams.lock() {
            for stream in streams.values() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
}

impl Default for LocalConnections {
    fn default() -> Self {
        Self::new()
    }
}

/// Removes one registered connection when its processing task exits.
pub struct LocalConnectionGuard {
    connections: Arc<LocalConnections>,
    id: u64,
}

impl Drop for LocalConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.connections.streams.lock() {
            streams.remove(&self.id);
        }
        self.connections.count.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
#[path = "local_socket_tests.rs"]
mod tests;
