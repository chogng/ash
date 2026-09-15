use crate::Error;
use crate::transport;
use exec_server_protocol::EnvironmentInfo;
use exec_server_protocol::ExecError;
use exec_server_protocol::Message;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::fmt;
use std::io::BufReader;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

// Retire idle sockets before the server's five-second read timeout. Failed exchanges are
// discarded and never replayed here; the caller decides whether an observation can be retried.
const IDLE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_IDLE_CONNECTIONS: usize = 4;

struct Connection {
    reader: BufReader<TcpStream>,
    used_at: Instant,
}

impl Connection {
    fn open(endpoint: &RemoteEndpoint) -> Result<Self, Error> {
        let stream = TcpStream::connect_timeout(&endpoint.address, Duration::from_secs(5))?;
        transport::configure(&stream)?;
        Ok(Self {
            reader: BufReader::new(stream),
            used_at: Instant::now(),
        })
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
    endpoint: RemoteEndpoint,
    info: EnvironmentInfo,
    connections: Arc<Mutex<Vec<Connection>>>,
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
        let mut connection = Connection::open(&endpoint)?;
        let response = exchange(&mut connection, &endpoint, None, Request::EnvironmentInfo)?;
        let Response::Environment(info) = response else {
            return Err(Error::Protocol);
        };
        exec_server_protocol::validate_id(&info.environment_id).map_err(|_| Error::Protocol)?;
        if !transport::valid_token(&info.incarnation) || info.root.is_empty() {
            return Err(Error::Protocol);
        }
        Ok(Self {
            endpoint,
            info,
            connections: Arc::new(Mutex::new(vec![connection])),
        })
    }
    pub fn info(&self) -> &EnvironmentInfo {
        &self.info
    }
    pub fn request(&self, request: Request) -> Result<Response, Error> {
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
    endpoint: &RemoteEndpoint,
    incarnation: Option<String>,
    request: Request,
) -> Result<Response, Error> {
    transport::write_frame(
        connection.reader.get_mut(),
        &Message {
            version: exec_server_protocol::VERSION,
            token: endpoint.token.clone(),
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
