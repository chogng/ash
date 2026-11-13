//! Connection-scoped, bounded TCP transport. Browser protocol policy remains with its caller.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::net::TcpStream;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

const CAPACITY: usize = 64;
pub const TCP_CHUNK_BYTES: usize = 65_536;

/// A live, sticky authorization owned by the caller's policy. Revocation must not be undone
/// by a later grant; a new connection needs a new authorization.
pub trait TcpAuthorization: std::fmt::Debug + Send + Sync {
    fn check(&self) -> io::Result<()>;
    fn revoked(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

#[derive(Debug)]
struct Socket {
    stream: TcpStream,
    authorization: Arc<dyn TcpAuthorization>,
}

impl Socket {
    fn check(&self) -> io::Result<()> {
        self.authorization.check().inspect_err(|_| {
            let _ = self.stream.shutdown(Shutdown::Both);
        })
    }
}

#[derive(Debug)]
struct Stream {
    revision: u64,
    socket: Option<Arc<Mutex<Socket>>>,
}

#[derive(Debug, Default)]
struct State {
    closed: bool,
    revision: u64,
    streams: BTreeMap<String, Stream>,
}

/// Owns the streams of exactly one authenticated protocol connection. Closing it also retires pending opens.
#[derive(Debug, Default)]
pub struct TcpStreams(Mutex<State>, ash_async_utils::CancellationSource);

// Cancellation can drop the open future while DNS/connect is pending. Retire only that
// reservation, never a replacement that has reused the same ID.
struct Reservation<'a> {
    streams: &'a TcpStreams,
    id: &'a str,
    revision: u64,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut state = self.streams.0.lock().unwrap();
        if state
            .streams
            .get(self.id)
            .is_some_and(|entry| entry.revision == self.revision && entry.socket.is_none())
        {
            state.streams.remove(self.id);
        }
    }
}

impl TcpStreams {
    pub async fn open(
        &self,
        id: String,
        destination: &crate::NetworkRequest,
        authorization: Arc<dyn TcpAuthorization>,
    ) -> io::Result<()> {
        if id.is_empty() || id.len() > 128 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        authorization.check()?;
        let host = destination.host();
        let port = destination.port();
        let revision = {
            let mut state = self.0.lock().unwrap();
            if state.closed {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            if state.streams.len() >= CAPACITY || state.streams.contains_key(&id) {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            // A closed ID can be reused while an earlier connect is still resolving DNS.
            // Only the reservation that started this connect may publish its result.
            state.revision += 1;
            let revision = state.revision;
            state.streams.insert(
                id.clone(),
                Stream {
                    revision,
                    socket: None,
                },
            );
            revision
        };
        let _reservation = Reservation {
            streams: self,
            id: &id,
            revision,
        };
        let result = async {
            let token = self.1.token();
            let stream = tokio::select! {
                biased;
                _ = authorization.revoked() => return Err(io::Error::from(io::ErrorKind::PermissionDenied)),
                _ = token.cancelled() => return Err(io::Error::from(io::ErrorKind::Interrupted)),
                result = tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect((host, port))) => result.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??,
            };
            stream.set_nodelay(true)?;
            let stream = stream.into_std()?;
            // Do not publish a connect that completed concurrently with revocation.
            authorization.check().inspect_err(|_| {
                let _ = stream.shutdown(Shutdown::Both);
            })?;
            Ok(stream)
        }.await;
        let mut state = self.0.lock().unwrap();
        match result {
            Ok(stream)
                if !state.closed
                    && state
                        .streams
                        .get(&id)
                        .is_some_and(|entry| entry.revision == revision) =>
            {
                state.streams.insert(
                    id.clone(),
                    Stream {
                        revision,
                        socket: Some(Arc::new(Mutex::new(Socket {
                            stream,
                            authorization,
                        }))),
                    },
                );
                Ok(())
            }
            Ok(stream) => {
                let _ = stream.shutdown(Shutdown::Both);
                Err(io::ErrorKind::Interrupted.into())
            }
            Err(error) => {
                if state
                    .streams
                    .get(&id)
                    .is_some_and(|entry| entry.revision == revision)
                {
                    state.streams.remove(&id);
                }
                Err(error)
            }
        }
    }

    fn stream(&self, id: &str) -> io::Result<Arc<Mutex<Socket>>> {
        self.0
            .lock()
            .unwrap()
            .streams
            .get(id)
            .and_then(|entry| entry.socket.clone())
            .ok_or_else(|| io::ErrorKind::NotFound.into())
    }

    pub fn read(&self, id: &str) -> io::Result<(Vec<u8>, bool)> {
        let stream = self.stream(id)?;
        let mut stream = stream.lock().unwrap();
        let mut bytes = vec![0; TCP_CHUNK_BYTES];
        // The check belongs after the socket lock: a queued operation must not carry an
        // authorization result obtained before another operation or a policy update.
        stream.check()?;
        let result = stream.stream.read(&mut bytes);
        stream.check()?;
        match result {
            Ok(count) => {
                bytes.truncate(count);
                Ok((bytes, count == 0))
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok((Vec::new(), false)),
            Err(error) => Err(error),
        }
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > TCP_CHUNK_BYTES {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let socket = self.stream(id)?;
        let mut socket = socket.lock().unwrap();
        socket.check()?;
        let result = socket.stream.write(bytes);
        socket.check()?;
        match result {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(0),
            result => result,
        }
    }

    pub fn end(&self, id: &str) -> io::Result<()> {
        let socket = self.stream(id)?;
        let socket = socket.lock().unwrap();
        socket.check()?;
        let result = socket.stream.shutdown(Shutdown::Write);
        socket.check()?;
        result
    }

    pub fn close(&self, id: &str) {
        if let Some(stream) = self
            .0
            .lock()
            .unwrap()
            .streams
            .remove(id)
            .and_then(|entry| entry.socket)
        {
            let _ = stream.lock().unwrap().stream.shutdown(Shutdown::Both);
        }
    }

    pub fn close_all(&self) {
        self.1.cancel();
        let streams = {
            let mut state = self.0.lock().unwrap();
            state.closed = true;
            std::mem::take(&mut state.streams)
        };
        for stream in streams.into_values().filter_map(|entry| entry.socket) {
            let _ = stream.lock().unwrap().stream.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for TcpStreams {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
#[path = "tcp_tests.rs"]
mod tests;
