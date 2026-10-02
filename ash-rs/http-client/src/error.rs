use std::fmt;

/// A safe failure produced while configuring or executing a raw HTTP request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HttpClientError {
    InvalidRequest(String),
    InvalidConfiguration(String),
    Transport(String),
    Connection(HttpConnectionFailure),
}

/// The failed stage of a connection attempt, without peer addresses or credentials.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpConnectionFailure {
    Dns,
    Proxy,
    Tls,
    CertificateConfiguration,
    Connect,
    Timeout,
}

impl fmt::Display for HttpConnectionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Dns => "DNS lookup failed",
            Self::Proxy => "proxy connection or tunnel failed",
            Self::Tls => "TLS certificate or handshake failed",
            Self::CertificateConfiguration => "system certificate verifier could not be created",
            Self::Connect => "connection failed",
            Self::Timeout => "connection timed out",
        })
    }
}

impl fmt::Display for HttpClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid HTTP request: {message}"),
            Self::InvalidConfiguration(message) => {
                write!(formatter, "invalid HTTP client configuration: {message}")
            }
            Self::Transport(message) => write!(formatter, "HTTP transport failed: {message}"),
            Self::Connection(failure) => write!(formatter, "HTTP connection failed: {failure}"),
        }
    }
}

impl std::error::Error for HttpClientError {}
