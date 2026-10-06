use std::fmt;
use std::time::Duration;

use http::HeaderMap;
use http::HeaderValue;
use http::header;
use http::uri::Authority;
use rustls::RootCertStore;
use url::Url;

use crate::Error;
use crate::Result;

/// Caller-approved proxy origin, TLS roots, and operation deadlines.
///
/// Approval belongs to the caller; this boundary checks exact origins without reading
/// policy files or account state. Certificate verification is always enabled.
pub struct ProxyConfig {
    pub(crate) origin: Url,
    pub(crate) roots: RootCertStore,
    pub(crate) connect_timeout: Duration,
    pub(crate) request_timeout: Duration,
}

impl ProxyConfig {
    pub fn new(origin: Url, approved_origins: &[Url], roots: RootCertStore) -> Result<Self> {
        validate_origin(&origin)?;
        for approved in approved_origins {
            validate_origin(approved)?;
        }
        if !approved_origins
            .iter()
            .any(|approved| approved.origin() == origin.origin())
        {
            return Err(Error::UntrustedProxy);
        }
        if roots.is_empty() {
            return Err(Error::InvalidInput("TLS roots are empty"));
        }
        Ok(Self {
            origin,
            roots,
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(10),
        })
    }

    /// Bounds DNS/QUIC setup and each CONNECT response, including stream allocation.
    pub fn with_timeouts(mut self, connect: Duration, request: Duration) -> Result<Self> {
        if connect.is_zero() || request.is_zero() {
            return Err(Error::InvalidInput("timeouts must be nonzero"));
        }
        self.connect_timeout = connect;
        self.request_timeout = request;
        Ok(self)
    }
}

fn validate_origin(origin: &Url) -> Result<()> {
    if origin.scheme() != "https"
        || origin.host().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
        || origin.port_or_known_default() == Some(0)
    {
        return Err(Error::InvalidInput("proxy must be an HTTPS origin"));
    }
    Ok(())
}

/// One TCP destination interpreted by the proxy, never resolved by this client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectTarget(pub(crate) Authority);

impl ConnectTarget {
    pub fn parse(value: &str) -> Result<Self> {
        let authority: Authority = value
            .parse()
            .map_err(|_| Error::InvalidInput("invalid CONNECT target"))?;
        if value.contains('@')
            || authority.host().is_empty()
            || !authority.port_u16().is_some_and(|port| port != 0)
        {
            return Err(Error::InvalidInput(
                "CONNECT target must include a nonzero port",
            ));
        }
        Ok(Self(authority))
    }
}

/// Sensitive bearer and proxy-specific extension headers for new CONNECT requests.
///
/// Login, storage, and refresh stay with the caller. Debug output is redacted;
/// underlying header values are marked sensitive before reaching HTTP/3.
#[derive(Clone)]
pub struct Credentials {
    pub(crate) headers: HeaderMap,
}

impl Credentials {
    pub fn bearer(token: &str, mut extensions: HeaderMap) -> Result<Self> {
        if token.trim_end_matches('=').is_empty()
            || token.len() > 64 * 1024
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
            || token.trim_end_matches('=').contains('=')
        {
            return Err(Error::InvalidInput("invalid bearer token"));
        }
        if extensions.len() > 16 {
            return Err(Error::InvalidInput("too many CONNECT extension headers"));
        }
        for name in extensions.keys() {
            if extensions.get_all(name).iter().count() != 1 {
                return Err(Error::InvalidInput("duplicate CONNECT extension header"));
            }
        }
        let mut total = 0;
        for (name, value) in &mut extensions {
            let name = name.as_str();
            if !name.starts_with("x-") || name.starts_with("x-forwarded-") || name == "x-real-ip" {
                return Err(Error::InvalidInput("invalid CONNECT extension header"));
            }
            if value.as_bytes().len() > 4 * 1024 {
                return Err(Error::InvalidInput("CONNECT extension value is too long"));
            }
            total += name.len() + value.as_bytes().len();
            value.set_sensitive(true);
        }
        if total > 16 * 1024 {
            return Err(Error::InvalidInput(
                "CONNECT extension metadata is too large",
            ));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Error::InvalidInput("invalid bearer token"))?;
        authorization.set_sensitive(true);
        extensions.insert(header::AUTHORIZATION, authorization);
        Ok(Self {
            headers: extensions,
        })
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Credentials([redacted])")
    }
}
