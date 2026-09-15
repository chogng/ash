use crate::Error;
use crate::transport;
use exec_server_protocol::EnvironmentInfo;
use exec_server_protocol::ExecError;
use exec_server_protocol::Message;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::fmt;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::time::Duration;

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
#[derive(Clone, Debug)]
pub struct ExecClient {
    endpoint: RemoteEndpoint,
    info: EnvironmentInfo,
}
impl ExecClient {
    pub fn connect(endpoint: RemoteEndpoint) -> Result<Self, Error> {
        let response = exchange(&endpoint, None, Request::EnvironmentInfo)?;
        let Response::Environment(info) = response else {
            return Err(Error::Protocol);
        };
        exec_server_protocol::validate_id(&info.environment_id).map_err(|_| Error::Protocol)?;
        if !transport::valid_token(&info.incarnation) || info.root.is_empty() {
            return Err(Error::Protocol);
        }
        Ok(Self { endpoint, info })
    }
    pub fn info(&self) -> &EnvironmentInfo {
        &self.info
    }
    pub fn request(&self, request: Request) -> Result<Response, Error> {
        exchange(&self.endpoint, Some(self.info.incarnation.clone()), request)
    }
}
fn exchange(
    endpoint: &RemoteEndpoint,
    incarnation: Option<String>,
    request: Request,
) -> Result<Response, Error> {
    let mut stream = TcpStream::connect_timeout(&endpoint.address, Duration::from_secs(5))?;
    transport::configure(&stream)?;
    transport::write_frame(
        &mut stream,
        &Message {
            version: exec_server_protocol::VERSION,
            token: endpoint.token.clone(),
            incarnation,
            request,
        },
    )?;
    match transport::read_frame(&mut stream)? {
        Response::Error(error) => Err(Error::Remote(error)),
        response => Ok(response),
    }
}
