use crate::ClientIdentityPolicy;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::NetworkTargetPolicy;
use crate::OutboundNetworkPolicy;
use crate::ProxyBypass;
use crate::ProxyPolicy;
use crate::RedirectPolicy;
use crate::TlsPolicy;
use std::fmt;
use std::io;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::net::ToSocketAddrs;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use std::task::Context;
use std::task::Poll;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;
use tokio_rustls::TlsConnector;

pub(crate) type SystemRootLoader =
    Arc<dyn Fn() -> Result<rustls::RootCertStore, HttpClientError> + Send + Sync>;

/// A construction-time snapshot of outbound proxy, TLS, timeout, and target policy,
/// with a live application host policy.
///
/// HTTP and WebSocket transports consume this value so environment proxy
/// resolution, certificate policy, and public-Internet filtering cannot drift
/// between their independent wire backends.
#[derive(Clone)]
pub struct OutboundNetworkSnapshot {
    inner: Arc<OutboundNetworkSnapshotInner>,
}

struct OutboundNetworkSnapshotInner {
    config: HttpClientConfig,
    policy: OutboundNetworkPolicy,
    proxy_url: Option<String>,
    proxy_bypass: ProxyBypass,
    system_root_loader: SystemRootLoader,
    secure_tls_config: OnceLock<Result<Arc<rustls::ClientConfig>, HttpClientError>>,
}

impl OutboundNetworkSnapshot {
    /// Resolves environment-backed policy once and validates cross-policy invariants.
    pub fn new(config: HttpClientConfig) -> Result<Self, HttpClientError> {
        Self::with_root_loader(
            config,
            OutboundNetworkPolicy::default(),
            Arc::new(system_root_store),
        )
    }

    /// Applies one live application policy to both HTTP and WebSocket transports.
    pub fn with_policy(
        config: HttpClientConfig,
        policy: OutboundNetworkPolicy,
    ) -> Result<Self, HttpClientError> {
        Self::with_root_loader(config, policy, Arc::new(system_root_store))
    }

    pub(crate) fn with_root_loader(
        config: HttpClientConfig,
        policy: OutboundNetworkPolicy,
        system_root_loader: SystemRootLoader,
    ) -> Result<Self, HttpClientError> {
        if config.network_targets() == NetworkTargetPolicy::PublicInternetOnly
            && (!matches!(config.proxy(), ProxyPolicy::Direct)
                || config.redirects() != RedirectPolicy::Reject)
        {
            return Err(HttpClientError::InvalidConfiguration(
                "public-Internet target filtering requires direct connections and rejected redirects"
                    .into(),
            ));
        }
        let (proxy_url, proxy_bypass) = resolve_proxy(config.proxy());
        Ok(Self {
            inner: Arc::new(OutboundNetworkSnapshotInner {
                config,
                policy,
                proxy_url,
                proxy_bypass,
                system_root_loader,
                secure_tls_config: OnceLock::new(),
            }),
        })
    }

    /// Selects the already-snapshotted direct or proxy route for one URL.
    pub fn proxy_route(&self, target_url: &str) -> Result<OutboundProxyRoute, HttpClientError> {
        self.inner.policy.check_url(target_url)?;
        let target = url::Url::parse(target_url).map_err(|_| {
            HttpClientError::InvalidRequest("outbound target URL is invalid".into())
        })?;
        if !matches!(target.scheme(), "http" | "https" | "ws" | "wss") {
            return Err(HttpClientError::InvalidRequest(
                "outbound target URL must use HTTP, HTTPS, WS, or WSS".into(),
            ));
        }
        let host = target.host_str().ok_or_else(|| {
            HttpClientError::InvalidRequest("outbound target URL has no host".into())
        })?;
        let Some(proxy_url) = &self.inner.proxy_url else {
            return Ok(OutboundProxyRoute::Direct);
        };
        if self
            .inner
            .proxy_bypass
            .matches(host, target.port_or_known_default())
        {
            return Ok(OutboundProxyRoute::Direct);
        }
        Ok(OutboundProxyRoute::Proxy(OutboundProxyTarget {
            url: proxy_url.clone(),
        }))
    }

    pub(crate) fn rustls_client_config(
        &self,
    ) -> Result<Arc<rustls::ClientConfig>, HttpClientError> {
        self.inner
            .secure_tls_config
            .get_or_init(|| {
                build_tls_config(
                    &self.inner.config,
                    SystemRoots::Load,
                    &self.inner.system_root_loader,
                )
            })
            .as_ref()
            .cloned()
            .map_err(Clone::clone)
    }

    /// Applies the snapshotted TLS/mTLS policy to one asynchronous transport stream.
    ///
    /// Hostname and certificate validation cannot be disabled by the caller.
    pub async fn connect_tls<S>(
        &self,
        server_name: &str,
        stream: S,
    ) -> Result<OutboundTlsStream<S>, HttpClientError>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin,
    {
        let server_name =
            rustls::pki_types::ServerName::try_from(server_name.to_owned()).map_err(|_| {
                HttpClientError::InvalidConfiguration("TLS server name is invalid".into())
            })?;
        let inner = TlsConnector::from(self.rustls_client_config()?)
            .connect(server_name, stream)
            .await
            .map_err(|_| HttpClientError::Transport("TLS handshake failed".into()))?;
        Ok(OutboundTlsStream { inner })
    }

    /// Rejects an empty resolution or any disallowed address class.
    pub fn validate_resolved_addresses(
        &self,
        addresses: &[SocketAddr],
    ) -> Result<(), HttpClientError> {
        if addresses.is_empty() {
            return Err(HttpClientError::Transport(
                "target resolved to no addresses".into(),
            ));
        }
        if self.inner.config.network_targets() == NetworkTargetPolicy::PublicInternetOnly
            && addresses
                .iter()
                .any(|address| !is_public_internet_ip(address.ip()))
        {
            return Err(HttpClientError::Transport(
                "target resolved to a non-public address".into(),
            ));
        }
        Ok(())
    }

    /// Returns the transport timeout snapshot shared by outbound backends.
    pub fn timeouts(&self) -> crate::TransportTimeouts {
        self.inner.config.timeouts()
    }

    pub fn policy(&self) -> &OutboundNetworkPolicy {
        &self.inner.policy
    }

    pub(crate) fn config(&self) -> &HttpClientConfig {
        &self.inner.config
    }

    pub(crate) fn resolved_proxy_url(&self) -> Option<&str> {
        self.inner.proxy_url.as_deref()
    }

    pub(crate) fn tls_config_without_system_roots(
        &self,
    ) -> Result<Arc<rustls::ClientConfig>, HttpClientError> {
        build_tls_config(
            &self.inner.config,
            SystemRoots::Skip,
            &self.inner.system_root_loader,
        )
    }
}

impl fmt::Debug for OutboundNetworkSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OutboundNetworkSnapshot")
            .field("config", &self.inner.config)
            .field("proxy_configured", &self.inner.proxy_url.is_some())
            .finish_non_exhaustive()
    }
}

/// The proxy route selected for one outbound target.
#[derive(Clone, Eq, PartialEq)]
pub enum OutboundProxyRoute {
    Direct,
    Proxy(OutboundProxyTarget),
}

impl fmt::Debug for OutboundProxyRoute {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Direct => formatter.write_str("OutboundProxyRoute::Direct"),
            Self::Proxy(_) => formatter.write_str("OutboundProxyRoute::Proxy([REDACTED])"),
        }
    }
}

/// A selected proxy endpoint whose debug representation hides credentials.
#[derive(Clone, Eq, PartialEq)]
pub struct OutboundProxyTarget {
    url: String,
}

impl OutboundProxyTarget {
    /// Returns the exact proxy URL for the transport backend.
    ///
    /// The value can contain credentials and must never enter logs or errors.
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl fmt::Debug for OutboundProxyTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OutboundProxyTarget([REDACTED])")
    }
}

/// A crate-owned asynchronous TLS stream produced by [`OutboundNetworkSnapshot`].
pub struct OutboundTlsStream<S> {
    inner: tokio_rustls::client::TlsStream<S>,
}

impl<S> AsyncRead for OutboundTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(context, buffer)
    }
}

impl<S> AsyncWrite for OutboundTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(context)
    }
}

fn resolve_proxy(policy: &ProxyPolicy) -> (Option<String>, ProxyBypass) {
    match policy {
        ProxyPolicy::Direct => (None, ProxyBypass::from_comma_separated("")),
        ProxyPolicy::FromEnvironment => (
            proxy_url_from_environment(),
            ProxyBypass::from_environment(),
        ),
        ProxyPolicy::Explicit(proxy_url) => (
            Some(proxy_url.clone()),
            ProxyBypass::from_comma_separated(""),
        ),
        ProxyPolicy::ExplicitWithBypass { proxy_url, bypass } => {
            (Some(proxy_url.clone()), bypass.clone())
        }
    }
}

fn proxy_url_from_environment() -> Option<String> {
    [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .into_iter()
    .find_map(|name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
}

pub(crate) fn resolve_public_internet_target(netloc: &str) -> io::Result<Vec<SocketAddr>> {
    let addresses = netloc.to_socket_addrs()?.collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "target resolved to no addresses",
        ));
    }
    if addresses
        .iter()
        .any(|address| !is_public_internet_ip(address.ip()))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "target resolved to a non-public address",
        ));
    }
    Ok(addresses)
}

pub(crate) fn is_public_internet_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !matches!(
        (a, b, c),
        (0, _, _)
            | (10, _, _)
            | (100, 64..=127, _)
            | (127, _, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0..=2)
            | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (224..=255, _, _)
    )
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    let segments = address.segments();
    !address.is_unspecified()
        && !address.is_loopback()
        && !address.is_multicast()
        && !segments[..6].iter().all(|segment| *segment == 0)
        && !(segments[0] == 0x0064 && segments[1] == 0xff9b)
        && !(segments[0] == 0x0100 && segments[1..4].iter().all(|segment| *segment == 0))
        && !(segments[0] == 0x2001 && segments[1] <= 0x01ff)
        && segments[0] != 0x2002
        && segments[0] & 0xfff0 != 0x3ff0
        && segments[0] != 0x5f00
        && segments[0] & 0xfe00 != 0xfc00
        && segments[0] & 0xffc0 != 0xfe80
        && segments[0] & 0xffc0 != 0xfec0
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn build_tls_config(
    config: &HttpClientConfig,
    system_roots: SystemRoots,
    system_root_loader: &SystemRootLoader,
) -> Result<Arc<rustls::ClientConfig>, HttpClientError> {
    let mut roots = match config.tls() {
        TlsPolicy::SystemRoots | TlsPolicy::SystemPlus(_) => match system_roots {
            SystemRoots::Load => system_root_loader()?,
            SystemRoots::Skip => rustls::RootCertStore::empty(),
        },
        TlsPolicy::CustomOnly(_) => rustls::RootCertStore::empty(),
    };
    match config.tls() {
        TlsPolicy::SystemRoots => {}
        TlsPolicy::SystemPlus(bundle) | TlsPolicy::CustomOnly(bundle) => {
            add_certificate_bundle(&mut roots, bundle.certificates())?;
        }
    }

    let builder = rustls::ClientConfig::builder_with_provider(
        rustls::crypto::ring::default_provider().into(),
    )
    .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
    .map_err(|_| {
        HttpClientError::InvalidConfiguration("TLS provider has no usable protocol versions".into())
    })?
    .with_root_certificates(roots);
    let tls_config = match config.client_identity() {
        ClientIdentityPolicy::None => builder.with_no_client_auth(),
        ClientIdentityPolicy::Identity(identity) => builder
            .with_client_auth_cert(
                identity.certificate_chain().collect(),
                identity.private_key()?,
            )
            .map_err(|_| {
                HttpClientError::InvalidConfiguration(
                    "client certificate chain and private key do not match".into(),
                )
            })?,
    };
    Ok(Arc::new(tls_config))
}

pub(crate) fn system_root_store() -> Result<rustls::RootCertStore, HttpClientError> {
    let native_certificates = rustls_native_certs::load_native_certs().map_err(|_| {
        HttpClientError::InvalidConfiguration("failed to load system certificate roots".into())
    })?;
    let mut roots = rustls::RootCertStore::empty();
    let (valid_count, _) = roots.add_parsable_certificates(native_certificates);
    if valid_count == 0 {
        return Err(HttpClientError::InvalidConfiguration(
            "system certificate roots are empty".into(),
        ));
    }
    Ok(roots)
}

fn add_certificate_bundle(
    roots: &mut rustls::RootCertStore,
    certificates: impl IntoIterator<Item = rustls::pki_types::CertificateDer<'static>>,
) -> Result<(), HttpClientError> {
    for certificate in certificates {
        roots.add(certificate).map_err(|_| {
            HttpClientError::InvalidConfiguration(
                "certificate bundle contains an invalid trust root".into(),
            )
        })?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum SystemRoots {
    Load,
    Skip,
}
