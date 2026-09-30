use crate::Error;
use crate::transport;
use exec_server_protocol::EnvironmentInfo;
use exec_server_protocol::ExecError;
use exec_server_protocol::Message;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::fmt;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

// Retire idle sockets before the server's five-second read timeout. Failed exchanges are
// discarded and never replayed here; the caller decides whether an observation can be retried.
const IDLE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_IDLE_CONNECTIONS: usize = 4;
const MAX_ACTIVE_CONNECTIONS: usize = 32;

struct Admission(Arc<AtomicUsize>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Connection {
    reader: BufReader<Stream>,
    used_at: Instant,
}

impl Connection {
    fn open(endpoint: &Endpoint) -> Result<Self, Error> {
        let stream = match endpoint {
            Endpoint::Tcp(endpoint) => {
                let stream = TcpStream::connect_timeout(&endpoint.address, Duration::from_secs(5))?;
                transport::configure(&stream)?;
                Stream::Tcp(stream)
            }
            Endpoint::Ssh(endpoint) => Stream::Ssh(crate::ssh::SshStream::open(endpoint)?),
        };
        Ok(Self {
            reader: BufReader::new(stream),
            used_at: Instant::now(),
        })
    }
}

#[derive(Clone, Debug)]
enum Endpoint {
    Tcp(RemoteEndpoint),
    Ssh(crate::SshEndpoint),
}

enum Stream {
    Tcp(TcpStream),
    Ssh(crate::ssh::SshStream),
}
impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(stream) => stream.read(bytes),
            Self::Ssh(stream) => stream.read(bytes),
        }
    }
}
impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(stream) => stream.write(bytes),
            Self::Ssh(stream) => stream.write(bytes),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.flush(),
            Self::Ssh(stream) => stream.flush(),
        }
    }
}

/// Host configuration for an authenticated endpoint, reached directly or through a secure tunnel.
#[derive(Clone)]
pub struct RemoteEndpoint {
    address: SocketAddr,
    token: String,
}
impl RemoteEndpoint {
    pub fn new(address: SocketAddr, token: String) -> Result<Self, Error> {
        if !address.ip().is_loopback() || !transport::valid_token(&token) {
            return Err(Error::Remote(ExecError::InvalidInput));
        }
        Ok(Self { address, token })
    }
}
impl fmt::Debug for RemoteEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteEndpoint")
            .field("address", &self.address)
            .finish_non_exhaustive()
    }
}

/// Pins an environment incarnation. Calls never retry a mutation or silently adopt a restarted host.
#[derive(Clone)]
pub struct ExecClient {
    endpoint: Endpoint,
    info: EnvironmentInfo,
    connections: Arc<Mutex<Vec<Connection>>>,
    active: Arc<AtomicUsize>,
}
impl fmt::Debug for ExecClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecClient")
            .field("endpoint", &self.endpoint)
            .field("info", &self.info)
            .finish_non_exhaustive()
    }
}
impl ExecClient {
    pub fn connect(endpoint: RemoteEndpoint) -> Result<Self, Error> {
        Self::open(Endpoint::Tcp(endpoint))
    }

    pub fn connect_ssh(endpoint: crate::SshEndpoint) -> Result<Self, Error> {
        Self::open(Endpoint::Ssh(endpoint))
    }

    fn open(endpoint: Endpoint) -> Result<Self, Error> {
        let mut connection = Connection::open(&endpoint)?;
        let response = exchange(&mut connection, &endpoint, None, Request::EnvironmentInfo)?;
        let Response::Environment(info) = response else {
            return Err(Error::Protocol);
        };
        exec_server_protocol::validate_id(&info.environment_id).map_err(|_| Error::Protocol)?;
        if !transport::valid_token(&info.incarnation) || info.root.is_empty() {
            return Err(Error::Protocol);
        }
        if let Endpoint::Ssh(endpoint) = &endpoint
            && info.environment_id != endpoint.environment()
        {
            return Err(Error::Protocol);
        }
        Ok(Self {
            endpoint,
            info,
            connections: Arc::new(Mutex::new(vec![connection])),
            active: Arc::new(AtomicUsize::new(0)),
        })
    }
    pub fn info(&self) -> &EnvironmentInfo {
        &self.info
    }
    /// Reads a complete revision-pinned file through bounded protocol frames.
    pub fn read_file(
        &self,
        path: &str,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<exec_server_protocol::FileContent, Error> {
        crate::file_transfer::read_file(|request| self.request(request), path, cancellation)
    }

    /// Commits an upload once; a lost commit response is reconciled only by observing its receipt.
    pub fn write_file(
        &self,
        operation_id: &str,
        path: &str,
        bytes: &[u8],
        condition: exec_server_protocol::WriteCondition,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<(), Error> {
        crate::file_transfer::write_file(
            |request| self.request(request),
            operation_id,
            path,
            bytes,
            condition,
            cancellation,
        )
    }

    pub fn request(&self, request: Request) -> Result<Response, Error> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_ACTIVE_CONNECTIONS).then_some(count + 1)
            })
            .map_err(|_| Error::Remote(ExecError::Busy))?;
        let _admission = Admission(Arc::clone(&self.active));
        let connection = {
            let mut idle = self.connections.lock().map_err(|_| Error::Protocol)?;
            idle.retain(|connection| connection.used_at.elapsed() < IDLE_TIMEOUT);
            idle.pop()
        };
        let mut connection = match connection {
            Some(connection) => connection,
            None => Connection::open(&self.endpoint)?,
        };
        let response = exchange(
            &mut connection,
            &self.endpoint,
            Some(self.info.incarnation.clone()),
            request,
        )?;
        let mut idle = self.connections.lock().map_err(|_| Error::Protocol)?;
        if idle.len() < MAX_IDLE_CONNECTIONS {
            idle.push(connection);
        }
        Ok(response)
    }
}
fn exchange(
    connection: &mut Connection,
    endpoint: &Endpoint,
    incarnation: Option<String>,
    request: Request,
) -> Result<Response, Error> {
    transport::write_frame(
        connection.reader.get_mut(),
        &Message {
            version: exec_server_protocol::VERSION,
            token: match endpoint {
                Endpoint::Tcp(endpoint) => endpoint.token.clone(),
                Endpoint::Ssh(_) => String::new(),
            },
            incarnation,
            request,
        },
    )?;
    let response = transport::read_frame(&mut connection.reader)?;
    connection.used_at = Instant::now();
    match response {
        Response::Error(error) => Err(Error::Remote(error)),
        response => Ok(response),
    }
}
