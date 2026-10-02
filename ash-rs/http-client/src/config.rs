use crate::HttpClientError;
use std::fmt;
use std::num::NonZeroU8;
use std::num::NonZeroUsize;
use std::time::Duration;
use zeroize::Zeroizing;

/// Selects how an HTTP client discovers an outbound proxy.
#[derive(Clone, Eq, PartialEq)]
pub enum ProxyPolicy {
    /// Connect directly and ignore proxy environment variables.
    Direct,
    /// Resolve proxy and bypass variables when the client is built.
    FromEnvironment,
    /// Use one explicitly configured proxy URL.
    Explicit(String),
    /// Use one explicitly configured proxy URL except for matching targets.
    ExplicitWithBypass {
        proxy_url: String,
        bypass: ProxyBypass,
    },
}

impl fmt::Debug for ProxyPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Direct => formatter.write_str("ProxyPolicy::Direct"),
            Self::FromEnvironment => formatter.write_str("ProxyPolicy::FromEnvironment"),
            Self::Explicit(_) => formatter.write_str("ProxyPolicy::Explicit([REDACTED])"),
            Self::ExplicitWithBypass { .. } => {
                formatter.write_str("ProxyPolicy::ExplicitWithBypass([REDACTED])")
            }
        }
    }
}

/// A snapshot of target authorities that must connect directly instead of using a proxy.
///
/// Rules use standard `NO_PROXY` forms: `*`, an exact hostname or IP literal,
/// a domain suffix such as `.internal.example`, and an optional `:port`. The
/// proxy policy owns the decision; callers do not manually choose a client per
/// request.
#[derive(Clone, Eq, PartialEq)]
pub struct ProxyBypass {
    rules: Vec<String>,
}

impl ProxyBypass {
    /// Parses a comma-separated set of `NO_PROXY`-style bypass rules.
    pub fn from_comma_separated(rules: impl AsRef<str>) -> Self {
        Self {
            rules: rules
                .as_ref()
                .split(',')
                .map(str::trim)
                .filter(|rule| !rule.is_empty())
                .map(|rule| rule.to_ascii_lowercase())
                .collect(),
        }
    }

    pub(crate) fn from_environment() -> Self {
        let value = std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .unwrap_or_default();
        Self::from_comma_separated(value)
    }

    pub(crate) fn matches(&self, host: &str, port: Option<u16>) -> bool {
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        self.rules
            .iter()
            .any(|rule| rule_matches(rule, &host, port))
    }
}

impl fmt::Debug for ProxyBypass {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProxyBypass")
            .field("rule_count", &self.rules.len())
            .finish_non_exhaustive()
    }
}

fn rule_matches(rule: &str, host: &str, port: Option<u16>) -> bool {
    if rule == "*" {
        return true;
    }
    let (rule_host, rule_port) = split_authority(rule);
    if rule_port.is_some() && rule_port != port {
        return false;
    }
    let rule_host = rule_host.trim_start_matches('.');
    host == rule_host || host.ends_with(&format!(".{rule_host}"))
}

fn split_authority(value: &str) -> (&str, Option<u16>) {
    if let Some(bracket_end) = value.find(']')
        && value.starts_with('[')
    {
        let host = &value[1..bracket_end];
        let port = value[bracket_end + 1..]
            .strip_prefix(':')
            .and_then(|port| port.parse().ok());
        return (host, port);
    }
    let Some((host, port)) = value.rsplit_once(':') else {
        return (value, None);
    };
    let Ok(port) = port.parse() else {
        return (value, None);
    };
    if host.contains(':') {
        (value, None)
    } else {
        (host, Some(port))
    }
}

/// Selects redirect behavior for a transport attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RedirectPolicy {
    Reject,
    Follow { max_hops: NonZeroU8 },
}

/// Represents an enabled or disabled timeout without an ambiguous optional duration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Timeout {
    Disabled,
    After(Duration),
}

/// Socket and whole-attempt timeouts applied by the HTTP transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransportTimeouts {
    connect: Timeout,
    read: Timeout,
    write: Timeout,
    overall: Timeout,
}

impl TransportTimeouts {
    pub const fn new(connect: Timeout, read: Timeout, write: Timeout, overall: Timeout) -> Self {
        Self {
            connect,
            read,
            write,
            overall,
        }
    }

    pub const fn connect(&self) -> Timeout {
        self.connect
    }

    pub const fn read(&self) -> Timeout {
        self.read
    }

    pub const fn write(&self) -> Timeout {
        self.write
    }

    pub const fn overall(&self) -> Timeout {
        self.overall
    }
}

impl Default for TransportTimeouts {
    fn default() -> Self {
        Self::new(
            Timeout::After(Duration::from_secs(30)),
            Timeout::Disabled,
            Timeout::Disabled,
            Timeout::After(Duration::from_secs(60)),
        )
    }
}

/// Limits retained idle connections in the shared connection pool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectionPoolPolicy {
    max_idle_connections: usize,
    max_idle_connections_per_host: usize,
}

impl ConnectionPoolPolicy {
    pub const fn new(max_idle_connections: usize, max_idle_connections_per_host: usize) -> Self {
        Self {
            max_idle_connections,
            max_idle_connections_per_host,
        }
    }

    pub const fn max_idle_connections(&self) -> usize {
        self.max_idle_connections
    }

    pub const fn max_idle_connections_per_host(&self) -> usize {
        self.max_idle_connections_per_host
    }
}

impl Default for ConnectionPoolPolicy {
    fn default() -> Self {
        Self::new(100, 1)
    }
}

/// A hard upper bound for a buffered response or one successful streamed body.
///
/// [`HttpClientConfig`] keeps separate values for buffered responses and successful streaming
/// responses so large artifacts do not also authorization oversized diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResponseBodyLimit {
    bytes: NonZeroUsize,
}

impl ResponseBodyLimit {
    /// Creates a limit that leaves one byte of headroom for overflow detection.
    pub fn new(bytes: NonZeroUsize) -> Result<Self, HttpClientError> {
        if bytes.get() == usize::MAX {
            return Err(HttpClientError::InvalidConfiguration(
                "response body limit must be smaller than the platform maximum".into(),
            ));
        }
        Ok(Self { bytes })
    }

    pub const fn bytes(&self) -> NonZeroUsize {
        self.bytes
    }
}

impl Default for ResponseBodyLimit {
    fn default() -> Self {
        Self::new(NonZeroUsize::new(10 * 1024 * 1024).expect("ten MiB is non-zero"))
            .expect("ten MiB is below the platform maximum")
    }
}

/// An owned, DER-encoded certificate chain or trust bundle.
///
/// This type does not expose its certificate bytes through `Debug`. Callers
/// load and validate secret material before building the immutable HTTP client
/// generation, rather than reading certificate files during request execution.
#[derive(Clone, Eq, PartialEq)]
pub struct CertificateBundle {
    certificates: Vec<Vec<u8>>,
}

impl CertificateBundle {
    /// Creates a non-empty bundle of DER-encoded X.509 certificates.
    pub fn from_der(certificates: Vec<Vec<u8>>) -> Result<Self, HttpClientError> {
        if certificates.is_empty() || certificates.iter().any(Vec::is_empty) {
            return Err(HttpClientError::InvalidConfiguration(
                "certificate bundle must contain non-empty DER certificates".into(),
            ));
        }
        Ok(Self { certificates })
    }

    pub(crate) fn certificates(
        &self,
    ) -> impl Iterator<Item = rustls::pki_types::CertificateDer<'static>> + '_ {
        self.certificates
            .iter()
            .cloned()
            .map(rustls::pki_types::CertificateDer::from)
    }
}

impl fmt::Debug for CertificateBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CertificateBundle")
            .field("certificate_count", &self.certificates.len())
            .finish_non_exhaustive()
    }
}

/// A certificate chain and private key used for mutual TLS client authentication.
///
/// Both certificate and private-key bytes remain private and are redacted from
/// debug output. The key must be a DER-encoded PKCS#1, PKCS#8, or SEC1 key.
#[derive(Clone, Eq, PartialEq)]
pub struct ClientIdentity {
    certificate_chain: CertificateBundle,
    private_key_der: Zeroizing<Vec<u8>>,
}

impl ClientIdentity {
    /// Combines a client certificate chain with its DER-encoded private key.
    pub fn from_der(
        certificate_chain: CertificateBundle,
        private_key_der: Vec<u8>,
    ) -> Result<Self, HttpClientError> {
        if private_key_der.is_empty() {
            return Err(HttpClientError::InvalidConfiguration(
                "client private key must not be empty".into(),
            ));
        }
        Ok(Self {
            certificate_chain,
            private_key_der: Zeroizing::new(private_key_der),
        })
    }

    pub(crate) fn certificate_chain(
        &self,
    ) -> impl Iterator<Item = rustls::pki_types::CertificateDer<'static>> + '_ {
        self.certificate_chain.certificates()
    }

    pub(crate) fn private_key(
        &self,
    ) -> Result<rustls::pki_types::PrivateKeyDer<'static>, HttpClientError> {
        rustls::pki_types::PrivateKeyDer::try_from(self.private_key_der.to_vec()).map_err(|_| {
            HttpClientError::InvalidConfiguration(
                "client private key is not valid PKCS#1, PKCS#8, or SEC1 DER".into(),
            )
        })
    }
}

impl fmt::Debug for ClientIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientIdentity")
            .field("certificate_chain", &self.certificate_chain)
            .field("private_key_der", &"[REDACTED]")
            .finish()
    }
}

/// Selects the certificate roots used for HTTPS server validation.
///
/// Every variant preserves certificate-chain, expiry, and hostname validation;
/// no insecure "accept any certificate" mode is exposed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum TlsPolicy {
    #[default]
    SystemRoots,
    SystemPlus(CertificateBundle),
    CustomOnly(CertificateBundle),
}

/// Selects whether the client presents a certificate for mutual TLS.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ClientIdentityPolicy {
    #[default]
    None,
    Identity(ClientIdentity),
}

/// Restricts which resolved network targets a transport may connect to.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NetworkTargetPolicy {
    /// Permit any address accepted by the operating-system resolver.
    #[default]
    Any,
    /// Permit only globally routable Internet addresses.
    ///
    /// This policy requires direct connections and caller-managed redirects so every hop is
    /// revalidated before any response body is consumed.
    PublicInternetOnly,
}

/// Complete configuration for a reusable synchronous HTTP transport client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpClientConfig {
    proxy: ProxyPolicy,
    redirects: RedirectPolicy,
    timeouts: TransportTimeouts,
    connection_pool: ConnectionPoolPolicy,
    response_body_limit: ResponseBodyLimit,
    streaming_response_body_limit: ResponseBodyLimit,
    tls: TlsPolicy,
    client_identity: ClientIdentityPolicy,
    network_targets: NetworkTargetPolicy,
}

impl HttpClientConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_proxy_policy(mut self, proxy: ProxyPolicy) -> Self {
        self.proxy = proxy;
        self
    }

    pub fn with_redirect_policy(mut self, redirects: RedirectPolicy) -> Self {
        self.redirects = redirects;
        self
    }

    pub fn with_timeouts(mut self, timeouts: TransportTimeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    pub fn with_connection_pool(mut self, connection_pool: ConnectionPoolPolicy) -> Self {
        self.connection_pool = connection_pool;
        self
    }

    pub fn with_response_body_limit(mut self, response_body_limit: ResponseBodyLimit) -> Self {
        self.response_body_limit = response_body_limit;
        self
    }

    /// Sets the total successful body limit for [`crate::HttpClient::execute_streaming`].
    ///
    /// Non-success streaming responses remain governed by [`Self::with_response_body_limit`]
    /// because the transport buffers those diagnostics instead of sending them to the sink.
    pub fn with_streaming_response_body_limit(
        mut self,
        streaming_response_body_limit: ResponseBodyLimit,
    ) -> Self {
        self.streaming_response_body_limit = streaming_response_body_limit;
        self
    }

    pub fn with_tls_policy(mut self, tls: TlsPolicy) -> Self {
        self.tls = tls;
        self
    }

    pub fn with_client_identity_policy(mut self, client_identity: ClientIdentityPolicy) -> Self {
        self.client_identity = client_identity;
        self
    }

    pub fn with_network_target_policy(mut self, network_targets: NetworkTargetPolicy) -> Self {
        self.network_targets = network_targets;
        self
    }

    pub fn proxy(&self) -> &ProxyPolicy {
        &self.proxy
    }

    pub const fn redirects(&self) -> RedirectPolicy {
        self.redirects
    }

    pub const fn timeouts(&self) -> TransportTimeouts {
        self.timeouts
    }

    pub const fn connection_pool(&self) -> ConnectionPoolPolicy {
        self.connection_pool
    }

    pub const fn response_body_limit(&self) -> ResponseBodyLimit {
        self.response_body_limit
    }

    pub const fn streaming_response_body_limit(&self) -> ResponseBodyLimit {
        self.streaming_response_body_limit
    }

    pub fn tls(&self) -> &TlsPolicy {
        &self.tls
    }

    pub fn client_identity(&self) -> &ClientIdentityPolicy {
        &self.client_identity
    }

    pub const fn network_targets(&self) -> NetworkTargetPolicy {
        self.network_targets
    }
}

impl Default for HttpClientConfig {
    fn default() -> Self {
        Self {
            proxy: ProxyPolicy::FromEnvironment,
            redirects: RedirectPolicy::Reject,
            timeouts: TransportTimeouts::default(),
            connection_pool: ConnectionPoolPolicy::default(),
            response_body_limit: ResponseBodyLimit::default(),
            streaming_response_body_limit: ResponseBodyLimit::default(),
            tls: TlsPolicy::SystemRoots,
            client_identity: ClientIdentityPolicy::None,
            network_targets: NetworkTargetPolicy::Any,
        }
    }
}

/// Negotiated HTTP/2 or a strict HTTP/1.1 transport for incompatible proxies.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HttpCompatibilityMode {
    #[default]
    Http2,
    Http1,
}
