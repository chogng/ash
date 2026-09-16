use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpRequest;
use crate::HttpResponse;
use crate::NetworkTargetPolicy;
use crate::OutboundNetworkSnapshot;
use crate::OutboundProxyRoute;
use crate::RedirectPolicy;
use crate::Timeout;
use crate::outbound_network::SystemRootLoader;
use crate::outbound_network::resolve_public_internet_target;
use crate::outbound_network::system_root_store;
use std::io::Read;
use std::sync::Arc;
use std::sync::OnceLock;

/// Executes a fully constructed HTTP request once.
///
/// Implementations own proxy selection, TLS server validation, redirect
/// handling, transport timeouts, and connection reuse. They must not retry:
/// the operation client above this trait decides whether a request body is safe
/// to replay.
pub trait HttpClient: Send + Sync {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError>;

    /// Executes one request and incrementally emits a successful response body.
    ///
    /// Non-success response bodies remain buffered in the returned response so
    /// operation-level retry and status handling can inspect them. Transports
    /// without incremental execution reject the operation before sending a request.
    fn execute_streaming(
        &self,
        _: &HttpRequest,
        _: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        Err(HttpClientError::InvalidRequest(
            "HTTP client does not support streaming".into(),
        ))
    }
}

/// Receives ordered byte chunks from one successful HTTP response body.
///
/// Implementations should apply backpressure and return an error as soon as
/// the consumer can no longer safely accept bytes. A sink is scoped to one raw
/// transport attempt and must not interpret provider framing.
pub trait HttpBodySink {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError>;
}

/// The production synchronous HTTP client backed by one reusable `ureq` agent.
pub struct UreqHttpClient {
    network: OutboundNetworkSnapshot,
    http_direct_agent: ureq::Agent,
    http_proxy_agent: Option<ureq::Agent>,
    response_body_limit: usize,
    streaming_response_body_limit: usize,
    https_direct_agent: OnceLock<Result<ureq::Agent, HttpClientError>>,
    https_proxy_agent: OnceLock<Result<ureq::Agent, HttpClientError>>,
}

impl UreqHttpClient {
    /// Builds the production client with the default transport policy.
    ///
    /// Static proxy, custom-certificate, and client-identity configuration is validated here.
    /// Platform certificate roots are loaded lazily on the first HTTPS request so an HTTP-only
    /// client remains usable in offline or restricted hosts.
    pub fn new() -> Result<Self, HttpClientError> {
        Self::with_config(HttpClientConfig::default())
    }

    pub fn with_config(config: HttpClientConfig) -> Result<Self, HttpClientError> {
        Self::with_config_and_root_loader(config, Arc::new(system_root_store))
    }

    fn with_config_and_root_loader(
        config: HttpClientConfig,
        system_root_loader: SystemRootLoader,
    ) -> Result<Self, HttpClientError> {
        Self::with_network(OutboundNetworkSnapshot::with_root_loader(
            config,
            system_root_loader,
        )?)
    }

    /// Shares the same immutable certificate, proxy and target policy as other transports.
    pub fn with_network(network: OutboundNetworkSnapshot) -> Result<Self, HttpClientError> {
        let config = network.config();
        let http_tls_config = network.tls_config_without_system_roots()?;
        let http_direct_agent = build_agent(config, http_tls_config.clone(), None)?;
        let proxy_url = network.resolved_proxy_url();
        let http_proxy_agent = proxy_url
            .map(|proxy_url| build_agent(config, http_tls_config, Some(proxy_url)))
            .transpose()?;
        let response_body_limit = config.response_body_limit().bytes().get();
        let streaming_response_body_limit = config.streaming_response_body_limit().bytes().get();

        Ok(Self {
            network,
            http_direct_agent,
            http_proxy_agent,
            response_body_limit,
            streaming_response_body_limit,
            https_direct_agent: OnceLock::new(),
            https_proxy_agent: OnceLock::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_test_system_root_loader(
        config: HttpClientConfig,
        loader: impl Fn() -> Result<rustls::RootCertStore, HttpClientError> + Send + Sync + 'static,
    ) -> Result<Self, HttpClientError> {
        Self::with_config_and_root_loader(config, Arc::new(loader))
    }

    fn agent_for(&self, request: &HttpRequest) -> Result<&ureq::Agent, HttpClientError> {
        let route = self.network.proxy_route(request.url())?;
        let proxy_url = match &route {
            OutboundProxyRoute::Direct => None,
            OutboundProxyRoute::Proxy(target) => Some(target.url()),
        };
        let use_proxy = proxy_url.is_some();
        let proxy_requires_tls =
            use_proxy && proxy_url.is_some_and(|url| url.starts_with("https://"));
        let request_requires_tls = request.url().starts_with("https://")
            || matches!(
                self.network.config().redirects(),
                crate::RedirectPolicy::Follow { .. }
            );
        if !request_requires_tls && !proxy_requires_tls {
            return if use_proxy {
                Ok(self
                    .http_proxy_agent
                    .as_ref()
                    .expect("a selected proxy always has an agent"))
            } else {
                Ok(&self.http_direct_agent)
            };
        }

        if use_proxy {
            self.https_proxy_agent
                .get_or_init(|| {
                    build_agent(self.network.config(), self.secure_tls_config()?, proxy_url)
                })
                .as_ref()
                .map_err(Clone::clone)
        } else {
            self.https_direct_agent
                .get_or_init(|| build_agent(self.network.config(), self.secure_tls_config()?, None))
                .as_ref()
                .map_err(Clone::clone)
        }
    }

    fn secure_tls_config(&self) -> Result<Arc<rustls::ClientConfig>, HttpClientError> {
        self.network.rustls_client_config()
    }
}

fn build_agent(
    config: &HttpClientConfig,
    tls_config: Arc<rustls::ClientConfig>,
    proxy_url: Option<&str>,
) -> Result<ureq::Agent, HttpClientError> {
    let mut builder = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .max_idle_connections(config.connection_pool().max_idle_connections())
        .max_idle_connections_per_host(config.connection_pool().max_idle_connections_per_host())
        .tls_config(tls_config);
    if config.network_targets() == NetworkTargetPolicy::PublicInternetOnly {
        builder = builder.resolver(resolve_public_internet_target);
    }
    if let Some(proxy_url) = proxy_url {
        let proxy = ureq::Proxy::new(proxy_url)
            .map_err(|_| HttpClientError::InvalidConfiguration("proxy URL is invalid".into()))?;
        builder = builder.proxy(proxy);
    }
    builder = match config.redirects() {
        RedirectPolicy::Reject => builder.redirects(0),
        RedirectPolicy::Follow { max_hops } => builder.redirects(u32::from(max_hops.get())),
    };
    let timeouts = config.timeouts();
    if let Timeout::After(timeout) = timeouts.connect() {
        builder = builder.timeout_connect(timeout);
    }
    if let Timeout::After(timeout) = timeouts.read() {
        builder = builder.timeout_read(timeout);
    }
    if let Timeout::After(timeout) = timeouts.write() {
        builder = builder.timeout_write(timeout);
    }
    if let Timeout::After(timeout) = timeouts.overall() {
        builder = builder.timeout(timeout);
    }
    Ok(builder.build())
}

impl HttpClient for UreqHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        let response = self.send(request)?;
        let status = response.status();
        let headers = response_headers(&response);
        let mut body = Vec::new();
        let read_limit = u64::try_from(self.response_body_limit)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        response
            .into_reader()
            .take(read_limit)
            .read_to_end(&mut body)
            .map_err(|_| HttpClientError::Transport("failed to read response body".into()))?;
        if body.len() > self.response_body_limit {
            return Err(HttpClientError::Transport(
                "response body exceeded configured limit".into(),
            ));
        }
        Ok(HttpResponse::new(status, headers, body))
    }

    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        let response = self.send(request)?;
        let status = response.status();
        let headers = response_headers(&response);
        if !(200..300).contains(&status) {
            let mut body = Vec::new();
            read_bounded(response.into_reader(), self.response_body_limit, |chunk| {
                body.extend_from_slice(chunk);
                Ok(())
            })?;
            return Ok(HttpResponse::new(status, headers, body));
        }
        read_bounded(
            response.into_reader(),
            self.streaming_response_body_limit,
            |chunk| sink.emit(chunk),
        )?;
        Ok(HttpResponse::new(status, headers, Vec::new()))
    }
}

impl UreqHttpClient {
    fn send(&self, request: &HttpRequest) -> Result<ureq::Response, HttpClientError> {
        let mut request_builder = self
            .agent_for(request)?
            .request(request.method().as_str(), request.url());
        for header in request.headers() {
            request_builder = request_builder.set(header.name(), header.value());
        }
        match request_builder.send_bytes(request.body()) {
            Ok(response) | Err(ureq::Error::Status(_, response)) => Ok(response),
            Err(ureq::Error::Transport(_)) => {
                Err(HttpClientError::Transport("request failed".into()))
            }
        }
    }
}

fn response_headers(response: &ureq::Response) -> Vec<crate::HttpHeader> {
    response
        .headers_names()
        .iter()
        .filter_map(|name| {
            response
                .header(name)
                .map(|value| crate::HttpHeader::new(name.as_str(), value))
        })
        .collect()
}

fn read_bounded(
    mut reader: impl Read,
    limit: usize,
    mut emit: impl FnMut(&[u8]) -> Result<(), HttpClientError>,
) -> Result<(), HttpClientError> {
    let mut total = 0usize;
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|_| HttpClientError::Transport("failed to read response body".into()))?;
        if read == 0 {
            return Ok(());
        }
        total = total.saturating_add(read);
        if total > limit {
            return Err(HttpClientError::Transport(
                "response body exceeded configured limit".into(),
            ));
        }
        emit(&chunk[..read])?;
    }
}
