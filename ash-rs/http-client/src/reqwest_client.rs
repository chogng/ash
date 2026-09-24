use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientError;
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
use ash_async_utils::CancellationToken;
use reqwest::dns::Addrs;
use reqwest::dns::Name;
use reqwest::dns::Resolve;
use reqwest::dns::Resolving;
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
    pub fn with_network(network: OutboundNetworkSnapshot) -> Result<Self, HttpClientError> {
        if !matches!(network.timeouts().write(), Timeout::Disabled) {
            return Err(HttpClientError::InvalidConfiguration(
                "async HTTP transport does not support a separate write timeout".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(ClientState {
                network,
                http_direct: OnceLock::new(),
                http_proxy: OnceLock::new(),
                https_direct: OnceLock::new(),
                https_proxy: OnceLock::new(),
            }),
        })
    }

    fn client_for(&self, url: &str) -> Result<reqwest::Client, HttpClientError> {
        match self.inner.network.proxy_route(url)? {
            OutboundProxyRoute::Direct if url.starts_with("https://") => self
                .inner
                .https_direct
                .get_or_init(|| self.build_client(None, TlsRoots::System))
                .clone(),
            OutboundProxyRoute::Direct => self
                .inner
                .http_direct
                .get_or_init(|| self.build_client(None, TlsRoots::ConfiguredOnly))
                .clone(),
            OutboundProxyRoute::Proxy(proxy)
                if url.starts_with("https://") || proxy.url().starts_with("https://") =>
            {
                self.inner
                    .https_proxy
                    .get_or_init(|| self.build_client(Some(proxy.url()), TlsRoots::System))
                    .clone()
            }
            OutboundProxyRoute::Proxy(proxy) => self
                .inner
                .http_proxy
                .get_or_init(|| self.build_client(Some(proxy.url()), TlsRoots::ConfiguredOnly))
                .clone(),
        }
    }

    fn build_client(
        &self,
        proxy: Option<&str>,
        roots: TlsRoots,
    ) -> Result<reqwest::Client, HttpClientError> {
        let config = self.inner.network.config();
        let tls = match roots {
            TlsRoots::System => self.inner.network.rustls_client_config()?,
            TlsRoots::ConfiguredOnly => self.inner.network.tls_config_without_system_roots()?,
        };
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .use_preconfigured_tls(tls.as_ref().clone())
            .pool_max_idle_per_host(
                config
                    .connection_pool()
                    .max_idle_connections_per_host()
                    .min(config.connection_pool().max_idle_connections()),
            );
        if let Some(proxy) = proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| {
                HttpClientError::InvalidConfiguration("proxy URL is invalid".into())
            })?);
        }
        if config.network_targets() == NetworkTargetPolicy::PublicInternetOnly {
            builder = builder.dns_resolver(Arc::new(PublicResolver));
        }
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
                    .map_err(|_| HttpClientError::Transport("request timed out".into()))?,
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
            let response = tokio::select! {
                biased;
                () = initial.revoked() => return Err(revoked()),
                () = permit.revoked() => return Err(revoked()),
                () = sender.closed() => return Err(HttpClientError::Transport("HTTP consumer disconnected".into())),
                response = builder.send() => response.map_err(|_| HttpClientError::Transport("request failed".into()))?,
            };
            initial.check()?;
            permit.check()?;
            if let RedirectPolicy::Follow { max_hops } = self.inner.network.config().redirects() {
                let next_method = match response.status().as_u16() {
                    301..=303 => match method {
                        HttpMethod::Get => Some(method),
                        HttpMethod::Post | HttpMethod::Delete => Some(HttpMethod::Get),
                    },
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
                    chunk = response.chunk() => chunk.map_err(|_| HttpClientError::Transport("failed to read response body".into()))?,
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
            return Ok(HttpResponse::new(status, headers, buffered));
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

struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty()
                || addresses
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
