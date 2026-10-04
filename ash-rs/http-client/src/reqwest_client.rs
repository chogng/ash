use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientError;
use crate::HttpCompatibilityMode;
use crate::HttpConnectionFailure;
use crate::HttpHeader;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::HttpResponse;
use crate::NetworkTargetPolicy;
use crate::OutboundNetworkSnapshot;
use crate::OutboundProxyRoute;
use crate::RedirectPolicy;
use crate::Timeout;
use crate::outbound_network::is_public_internet_ip;
use crate::request::ResponseReceivedAt;
use ash_async_utils::CancellationToken;
use reqwest::dns::Addrs;
use reqwest::dns::Name;
use reqwest::dns::Resolve;
use reqwest::dns::Resolving;
use rustls_platform_verifier::BuilderVerifierExt;
use std::io;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::mpsc;
use url::Url;

/// Executes application HTTP requests on cancellable asynchronous I/O.
///
/// The synchronous trait remains the boundary used by model and product clients;
/// its caller waits for the async task, while policy revocation drops the network future.
#[derive(Clone)]
pub struct ReqwestHttpClient {
    inner: Arc<ClientState>,
}

struct ClientState {
    network: OutboundNetworkSnapshot,
    pools: [ClientPool; 2],
}

#[derive(Default)]
struct ClientPool {
    http_direct: OnceLock<Result<reqwest::Client, HttpClientError>>,
    http_proxy: OnceLock<Result<reqwest::Client, HttpClientError>>,
    https_direct: OnceLock<Result<reqwest::Client, HttpClientError>>,
    https_proxy: OnceLock<Result<reqwest::Client, HttpClientError>>,
}

#[derive(Clone, Copy)]
enum BodyMode {
    Buffered,
    Streaming,
}

enum Message {
    Chunk(Vec<u8>),
    Complete(Result<HttpResponse, HttpClientError>),
}

impl ReqwestHttpClient {
    /// Keeps reqwest's OS certificate verification for SDKs that own their HTTP framing.
    /// The provider is explicit so feature unification cannot pick another crypto backend.
    pub fn sdk_client_builder() -> Result<reqwest::ClientBuilder, HttpClientError> {
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .and_then(|builder| builder.with_platform_verifier())
        .map_err(|_| {
            HttpClientError::InvalidConfiguration("failed to build HTTP transport".into())
        })?
        .with_no_client_auth();
        Ok(reqwest::Client::builder().tls_backend_preconfigured(tls))
    }

    pub fn with_network(network: OutboundNetworkSnapshot) -> Result<Self, HttpClientError> {
        if !matches!(network.timeouts().write(), Timeout::Disabled) {
            return Err(HttpClientError::InvalidConfiguration(
                "async HTTP transport does not support a separate write timeout".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(ClientState {
                network,
                pools: std::array::from_fn(|_| ClientPool::default()),
            }),
        })
    }

    fn client_for(&self, url: &str) -> Result<reqwest::Client, HttpClientError> {
        let mode = self.inner.network.http_compatibility_mode();
        let pool = &self.inner.pools[match mode {
            HttpCompatibilityMode::Http2 => 0,
            HttpCompatibilityMode::Http1 => 1,
        }];
        match self.inner.network.proxy_route(url)? {
            OutboundProxyRoute::Direct if url.starts_with("https://") => pool
                .https_direct
                .get_or_init(|| self.build_client(None, TlsRoots::System, mode))
                .clone(),
            OutboundProxyRoute::Direct => pool
                .http_direct
                .get_or_init(|| self.build_client(None, TlsRoots::ConfiguredOnly, mode))
                .clone(),
            OutboundProxyRoute::Proxy(proxy)
                if url.starts_with("https://") || proxy.url().starts_with("https://") =>
            {
                pool.https_proxy
                    .get_or_init(|| self.build_client(Some(proxy.url()), TlsRoots::System, mode))
                    .clone()
            }
            OutboundProxyRoute::Proxy(proxy) => pool
                .http_proxy
                .get_or_init(|| {
                    self.build_client(Some(proxy.url()), TlsRoots::ConfiguredOnly, mode)
                })
                .clone(),
        }
    }

    fn build_client(
        &self,
        proxy: Option<&str>,
        roots: TlsRoots,
        mode: HttpCompatibilityMode,
    ) -> Result<reqwest::Client, HttpClientError> {
        let config = self.inner.network.config();
        let tls = match roots {
            TlsRoots::System => self.inner.network.rustls_client_config()?,
            TlsRoots::ConfiguredOnly => self.inner.network.tls_config_without_system_roots()?,
        };
        // Reqwest preserves preconfigured TLS, so the selected HTTP mode must own ALPN too.
        let mut tls = tls.as_ref().clone();
        tls.alpn_protocols = match mode {
            HttpCompatibilityMode::Http2 => vec![b"h2".to_vec(), b"http/1.1".to_vec()],
            HttpCompatibilityMode::Http1 => vec![b"http/1.1".to_vec()],
        };
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .use_preconfigured_tls(tls)
            .pool_max_idle_per_host(
                config
                    .connection_pool()
                    .max_idle_connections_per_host()
                    .min(config.connection_pool().max_idle_connections()),
            );
        if mode == HttpCompatibilityMode::Http1 {
            builder = builder.http1_only();
        }
        if let Some(proxy) = proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| {
                HttpClientError::InvalidConfiguration("proxy URL is invalid".into())
            })?);
        }
        builder = builder.dns_resolver(Arc::new(ProductResolver(config.network_targets())));
        let timeouts = config.timeouts();
        if let Timeout::After(timeout) = timeouts.connect() {
            builder = builder.connect_timeout(timeout);
        }
        if let Timeout::After(timeout) = timeouts.read() {
            builder = builder.read_timeout(timeout);
        }
        builder.build().map_err(|_| {
            HttpClientError::InvalidConfiguration("failed to build HTTP transport".into())
        })
    }

    fn dispatch(
        &self,
        request: &HttpRequest,
        mode: BodyMode,
        cancellation: Option<&CancellationToken>,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        check_cancellation(cancellation)?;
        let permit = self.inner.network.policy().acquire(request.url())?;
        let caller_permit = permit.clone();
        let (sender, mut receiver) = mpsc::channel(1);
        let request = request.clone();
        let client = self.clone();
        let task_cancellation = cancellation.cloned();
        runtime()?.spawn(async move {
            let result = client
                .run(request, mode, permit, task_cancellation, &sender)
                .await;
            let _ = sender.send(Message::Complete(result)).await;
        });
        while let Some(message) = futures::executor::block_on(receiver.recv()) {
            match message {
                Message::Chunk(chunk) => {
                    check_cancellation(cancellation)?;
                    caller_permit.check()?;
                    sink.emit(&chunk)?;
                }
                Message::Complete(result) => {
                    check_cancellation(cancellation)?;
                    caller_permit.check()?;
                    return result;
                }
            }
        }
        Err(HttpClientError::Transport(
            "HTTP request ended without a result".into(),
        ))
    }

    async fn run(
        &self,
        request: HttpRequest,
        mode: BodyMode,
        initial: crate::NetworkPermit,
        cancellation: Option<CancellationToken>,
        sender: &mpsc::Sender<Message>,
    ) -> Result<HttpResponse, HttpClientError> {
        let work = self.run_with_deadline(request, mode, &initial, sender);
        let timed = async {
            match self.inner.network.timeouts().overall() {
                Timeout::Disabled => work.await,
                Timeout::After(limit) => tokio::time::timeout(limit, work)
                    .await
                    .map_err(|_| HttpClientError::Connection(HttpConnectionFailure::Timeout))?,
            }
        };
        match cancellation {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Err(cancelled()),
                result = timed => result,
            },
            None => timed.await,
        }
    }

    async fn run_with_deadline(
        &self,
        request: HttpRequest,
        mode: BodyMode,
        initial: &crate::NetworkPermit,
        sender: &mpsc::Sender<Message>,
    ) -> Result<HttpResponse, HttpClientError> {
        let mut url = Url::parse(request.url())
            .map_err(|_| HttpClientError::InvalidRequest("request URL is invalid".into()))?;
        let mut method = request.method();
        let mut body = request.body().to_vec();
        let mut hops = 0;
        loop {
            initial.check()?;
            if self.inner.network.config().network_targets()
                == NetworkTargetPolicy::PublicInternetOnly
            {
                let address = match url.host() {
                    Some(url::Host::Ipv4(address)) => Some(std::net::IpAddr::V4(address)),
                    Some(url::Host::Ipv6(address)) => Some(std::net::IpAddr::V6(address)),
                    _ => None,
                };
                if address.is_some_and(|address| !is_public_internet_ip(address)) {
                    return Err(HttpClientError::Transport(
                        "target resolved to a non-public address".into(),
                    ));
                }
            }
            let permit = self.inner.network.policy().acquire(url.as_str())?;
            let client = self.client_for(url.as_str())?;
            let mut builder = client.request(method_name(method), url.as_str());
            for header in request.headers() {
                if hops == 0 || !is_sensitive_redirect_header(header) {
                    builder = builder.header(header.name(), header.value());
                }
            }
            builder = builder.body(std::mem::take(&mut body));
            let route = self.inner.network.proxy_route(url.as_str())?;
            let response = tokio::select! {
                biased;
                () = initial.revoked() => return Err(revoked()),
                () = permit.revoked() => return Err(revoked()),
                () = sender.closed() => return Err(HttpClientError::Transport("HTTP consumer disconnected".into())),
                response = builder.send() => response.map_err(|error| connection_error(&error, &route))?,
            };
            initial.check()?;
            permit.check()?;
            if let RedirectPolicy::Follow { max_hops } = self.inner.network.config().redirects() {
                let next_method = match response.status().as_u16() {
                    301 | 302 => match method {
                        HttpMethod::Get => Some(method),
                        HttpMethod::Post | HttpMethod::Delete => Some(HttpMethod::Get),
                        HttpMethod::Patch | HttpMethod::Put => None,
                    },
                    303 => Some(HttpMethod::Get),
                    307 | 308 if method == HttpMethod::Get => Some(method),
                    _ => None,
                };
                if let (Some(next_method), Some(location)) = (
                    next_method,
                    response.headers().get(reqwest::header::LOCATION),
                ) {
                    if hops >= max_hops.get() {
                        return Err(HttpClientError::Transport("redirect limit exceeded".into()));
                    }
                    let location = location.to_str().map_err(|_| {
                        HttpClientError::InvalidRequest("redirect URL is invalid".into())
                    })?;
                    let next = url.join(location).map_err(|_| {
                        HttpClientError::InvalidRequest("redirect URL is invalid".into())
                    })?;
                    if !matches!(next.scheme(), "http" | "https") {
                        return Err(HttpClientError::InvalidRequest(
                            "redirect URL must use HTTP or HTTPS".into(),
                        ));
                    }
                    url = next;
                    method = next_method;
                    hops += 1;
                    continue;
                }
            }
            let received_at = ResponseReceivedAt::now();
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| HttpHeader::new(name.as_str(), value))
                })
                .collect();
            let streaming = matches!(mode, BodyMode::Streaming) && (200..300).contains(&status);
            let limit = if streaming {
                self.inner
                    .network
                    .config()
                    .streaming_response_body_limit()
                    .bytes()
                    .get()
            } else {
                self.inner
                    .network
                    .config()
                    .response_body_limit()
                    .bytes()
                    .get()
            };
            let mut response = response;
            let mut buffered = Vec::new();
            let mut total = 0usize;
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = initial.revoked() => return Err(revoked()),
                    () = permit.revoked() => return Err(revoked()),
                    () = sender.closed() => return Err(HttpClientError::Transport("HTTP consumer disconnected".into())),
                    chunk = response.chunk() => chunk.map_err(|error| connection_error(&error, &route))?,
                };
                let Some(chunk) = chunk else { break };
                total = total.saturating_add(chunk.len());
                if total > limit {
                    return Err(HttpClientError::Transport(
                        "response body exceeded configured limit".into(),
                    ));
                }
                initial.check()?;
                permit.check()?;
                if streaming {
                    tokio::select! {
                        biased;
                        () = initial.revoked() => return Err(revoked()),
                        () = permit.revoked() => return Err(revoked()),
                        result = sender.send(Message::Chunk(chunk.to_vec())) => {
                            result.map_err(|_| HttpClientError::Transport("HTTP consumer disconnected".into()))?;
                        }
                    }
                } else {
                    buffered.extend_from_slice(&chunk);
                }
            }
            initial.check()?;
            permit.check()?;
            return Ok(HttpResponse::with_received_at(
                status,
                headers,
                buffered,
                received_at,
            ));
        }
    }
}

#[derive(Clone, Copy)]
enum TlsRoots {
    System,
    ConfiguredOnly,
}

impl HttpClient for ReqwestHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.dispatch(request, BodyMode::Buffered, None, &mut NoBodySink)
    }

    fn execute_with_cancellation(
        &self,
        request: &HttpRequest,
        cancellation: &CancellationToken,
    ) -> Result<HttpResponse, HttpClientError> {
        self.dispatch(
            request,
            BodyMode::Buffered,
            Some(cancellation),
            &mut NoBodySink,
        )
    }

    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        self.dispatch(request, BodyMode::Streaming, None, sink)
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &HttpRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        self.dispatch(request, BodyMode::Streaming, Some(cancellation), sink)
    }
}

struct NoBodySink;

impl HttpBodySink for NoBodySink {
    fn emit(&mut self, _: &[u8]) -> Result<(), HttpClientError> {
        unreachable!("buffered HTTP request does not emit chunks")
    }
}

struct ProductResolver(NetworkTargetPolicy);

impl Resolve for ProductResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let policy = self.0;
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|_| Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>)?
                .collect::<Vec<_>>();
            if addresses.is_empty() {
                return Err(Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>);
            }
            if policy == NetworkTargetPolicy::PublicInternetOnly
                && addresses
                    .iter()
                    .any(|address| !is_public_internet_ip(address.ip()))
            {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "target resolved to a non-public address",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

// Keep the DNS stage in the error chain; matching backend error text would depend
// on the OS and could expose hostnames or proxy credentials in a diagnostic.
#[derive(Debug)]
struct DnsFailure;

impl std::fmt::Display for DnsFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DNS lookup failed")
    }
}

impl std::error::Error for DnsFailure {}

fn connection_error(error: &reqwest::Error, route: &OutboundProxyRoute) -> HttpClientError {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(source) = cause {
        if source.is::<DnsFailure>() {
            return HttpClientError::Connection(HttpConnectionFailure::Dns);
        }
        if source.is::<rustls::Error>() {
            return HttpClientError::Connection(HttpConnectionFailure::Tls);
        }
        // std::io::Error::source skips the wrapped error itself. Inspect that
        // boundary explicitly so rustls and resolver stages retain their type.
        cause = if let Some(error) = source.downcast_ref::<io::Error>() {
            error.get_ref().map(|inner| inner as &dyn std::error::Error)
        } else {
            source.source()
        };
    }
    if error.is_timeout() {
        return HttpClientError::Connection(HttpConnectionFailure::Timeout);
    }
    if error.is_connect() {
        return HttpClientError::Connection(match route {
            OutboundProxyRoute::Direct => HttpConnectionFailure::Connect,
            OutboundProxyRoute::Proxy(_) => HttpConnectionFailure::Proxy,
        });
    }
    HttpClientError::Transport("request failed".into())
}

fn runtime() -> Result<&'static tokio::runtime::Runtime, HttpClientError> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("ash-http-io")
                .build()
                .map_err(|_| "failed to start HTTP I/O runtime".to_owned())
        })
        .as_ref()
        .map_err(|message| HttpClientError::Transport(message.clone()))
}

fn method_name(method: HttpMethod) -> reqwest::Method {
    match method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Delete => reqwest::Method::DELETE,
    }
}

fn is_sensitive_redirect_header(header: &HttpHeader) -> bool {
    ["authorization", "cookie", "content-length"]
        .iter()
        .any(|name| header.name().eq_ignore_ascii_case(name))
}

fn revoked() -> HttpClientError {
    HttpClientError::InvalidRequest(
        "outbound HTTP request was revoked by application network policy".into(),
    )
}

fn cancelled() -> HttpClientError {
    HttpClientError::Transport("HTTP request cancelled".into())
}

fn check_cancellation(cancellation: Option<&CancellationToken>) -> Result<(), HttpClientError> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        Err(cancelled())
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "reqwest_client_tests.rs"]
mod tests;
