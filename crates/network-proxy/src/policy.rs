use ash_async_utils::CancellationToken;
use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkProtocol {
    Http,
    HttpsConnect,
    Socks5Tcp,
}

impl NetworkProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::HttpsConnect => "https_connect",
            Self::Socks5Tcp => "socks5_tcp",
        }
    }
}

/// One validated destination observed at the proxy, before any upstream connection is opened.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkRequest {
    protocol: NetworkProtocol,
    host: String,
    port: u16,
    method: Option<String>,
}

impl NetworkRequest {
    pub fn new(protocol: NetworkProtocol, host: &str, port: u16) -> io::Result<Self> {
        let host = host.trim_end_matches('.');
        if port == 0 || host.is_empty() || host.chars().any(char::is_whitespace) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid network target",
            ));
        }
        let host = url::Host::parse(host)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid network host"))?;
        Ok(Self {
            protocol,
            host: match host {
                url::Host::Domain(host) => host,
                url::Host::Ipv4(ip) => ip.to_string(),
                url::Host::Ipv6(ip) => ip.to_string(),
            },
            port,
            method: None,
        })
    }

    pub fn with_method(mut self, method: &str) -> Self {
        self.method = Some(method.to_owned());
        self
    }

    pub fn protocol(&self) -> NetworkProtocol {
        self.protocol
    }
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn method(&self) -> Option<&str> {
        self.method.as_deref()
    }

    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// The result authorizes only this request; it never changes the enclosing process sandbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NetworkDecision {
    Allow,
    Deny(String),
}

pub type NetworkDecisionFuture<'a> = Pin<Box<dyn Future<Output = NetworkDecision> + Send + 'a>>;

/// Evaluates every observed request using the host's frozen rules and approval authority.
///
/// Implementations must honor cancellation, bind approvals to the exact execution and target,
/// and return a denial when their authority cannot be reached.
pub trait NetworkPolicy: Send + Sync {
    fn decide(
        &self,
        request: NetworkRequest,
        cancellation: CancellationToken,
    ) -> NetworkDecisionFuture<'_>;
}

impl<F, Fut> NetworkPolicy for F
where
    F: Fn(NetworkRequest, CancellationToken) -> Fut + Send + Sync,
    Fut: Future<Output = NetworkDecision> + Send + 'static,
{
    fn decide(
        &self,
        request: NetworkRequest,
        cancellation: CancellationToken,
    ) -> NetworkDecisionFuture<'_> {
        Box::pin(self(request, cancellation))
    }
}

/// Cloneable host authorization bound to one command execution.
#[derive(Clone)]
pub struct NetworkPolicyHandle(Arc<dyn NetworkPolicy>);

impl NetworkPolicyHandle {
    pub fn new(policy: impl NetworkPolicy + 'static) -> Self {
        Self(Arc::new(policy))
    }

    pub fn decide(
        &self,
        request: NetworkRequest,
        cancellation: CancellationToken,
    ) -> NetworkDecisionFuture<'_> {
        self.0.decide(request, cancellation)
    }
}

impl fmt::Debug for NetworkPolicyHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NetworkPolicyHandle")
    }
}
