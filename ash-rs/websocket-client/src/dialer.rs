use crate::TcpNoDelay;
use crate::WebSocketClientError;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::OutboundProxyRoute;
use ash_http_client::Timeout;
use base64::Engine;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::handshake::client::Response;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use url::Url;
use zeroize::Zeroizing;

pub(crate) trait AsyncIo: AsyncRead + AsyncWrite + Send + Unpin {}

impl<T> AsyncIo for T where T: AsyncRead + AsyncWrite + Send + Unpin {}

pub(crate) type RoutedWebSocket = WebSocketStream<Box<dyn AsyncIo>>;

pub(crate) async fn connect(
    request: Request,
    config: WebSocketConfig,
    network: &OutboundNetworkSnapshot,
    tcp_no_delay: TcpNoDelay,
) -> Result<(RoutedWebSocket, Response), WebSocketClientError> {
    let target = Url::parse(&request.uri().to_string())
        .map_err(|_| WebSocketClientError::InvalidRequest("URL is invalid".into()))?;
    let host = target
        .host_str()
        .ok_or_else(|| WebSocketClientError::InvalidRequest("URL has no host".into()))?;
    let port = target
        .port_or_known_default()
        .ok_or_else(|| WebSocketClientError::InvalidRequest("URL has no usable port".into()))?;
    let route = network.proxy_route(target.as_str())?;

    let stream: Box<dyn AsyncIo> = match route {
        OutboundProxyRoute::Direct => {
            Box::new(connect_tcp(host, port, network, tcp_no_delay).await?)
        }
        OutboundProxyRoute::Proxy(proxy) => {
            let proxy = ProxyEndpoint::parse(proxy.url())?;
            let stream = connect_tcp(&proxy.host, proxy.port, network, tcp_no_delay).await?;
            let stream: Box<dyn AsyncIo> = if proxy.tls {
                Box::new(network.connect_tls(&proxy.host, stream).await?)
            } else {
                Box::new(stream)
            };
            tunnel_proxy(stream, &proxy, host, port).await?
        }
    };

    let stream: Box<dyn AsyncIo> = if target.scheme() == "wss" {
        Box::new(network.connect_tls(host, stream).await?)
    } else {
        stream
    };
    client_async_with_config(request, stream, Some(config))
        .await
        .map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                WebSocketClientError::HandshakeRejected(response.status().as_u16())
            }
            _ => WebSocketClientError::ConnectionFailed,
        })
}

struct ProxyEndpoint {
    host: String,
    port: u16,
    tls: bool,
    authorization: Option<Zeroizing<String>>,
}

impl ProxyEndpoint {
    fn parse(value: &str) -> Result<Self, WebSocketClientError> {
        let url = Url::parse(value).map_err(|_| {
            WebSocketClientError::InvalidConfiguration("proxy URL is invalid".into())
        })?;
        let tls = match url.scheme() {
            "http" => false,
            "https" => true,
            _ => {
                return Err(WebSocketClientError::InvalidConfiguration(
                    "proxy URL must use HTTP or HTTPS".into(),
                ));
            }
        };
        let host = url.host_str().ok_or_else(|| {
            WebSocketClientError::InvalidConfiguration("proxy URL has no host".into())
        })?;
        let port = url.port_or_known_default().ok_or_else(|| {
            WebSocketClientError::InvalidConfiguration("proxy URL has no port".into())
        })?;
        let authorization = if url.username().is_empty() {
            None
        } else {
            let credentials = Zeroizing::new(format!(
                "{}:{}",
                url.username(),
                url.password().unwrap_or_default()
            ));
            Some(Zeroizing::new(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
            )))
        };
        Ok(Self {
            host: host.to_string(),
            port,
            tls,
            authorization,
        })
    }
}

async fn tunnel_proxy(
    mut stream: Box<dyn AsyncIo>,
    proxy: &ProxyEndpoint,
    target_host: &str,
    target_port: u16,
) -> Result<Box<dyn AsyncIo>, WebSocketClientError> {
    let authority = host_port(target_host, target_port);
    let authorization = Zeroizing::new(
        proxy
            .authorization
            .as_deref()
            .map(|value| format!("Proxy-Authorization: {value}\r\n"))
            .unwrap_or_default(),
    );
    let authorization_header = authorization.as_str();
    let request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n{authorization_header}\r\n"
    ));
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| WebSocketClientError::ConnectionFailed)?;
    stream
        .flush()
        .await
        .map_err(|_| WebSocketClientError::ConnectionFailed)?;

    let mut response = Zeroizing::new(Vec::new());
    let mut byte = [0u8; 1];
    while response.len() < 16 * 1024 {
        let read = stream
            .read(&mut byte)
            .await
            .map_err(|_| WebSocketClientError::ConnectionFailed)?;
        if read == 0 {
            return Err(WebSocketClientError::ConnectionFailed);
        }
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            let status_line = response
                .split(|byte| *byte == b'\n')
                .next()
                .ok_or(WebSocketClientError::ConnectionFailed)?;
            let success = status_line
                .split(|byte| *byte == b' ')
                .nth(1)
                .is_some_and(|status| status == b"200");
            return if success {
                Ok(stream)
            } else {
                Err(WebSocketClientError::ConnectionFailed)
            };
        }
    }
    Err(WebSocketClientError::ConnectionFailed)
}

async fn connect_tcp(
    host: &str,
    port: u16,
    network: &OutboundNetworkSnapshot,
    tcp_no_delay: TcpNoDelay,
) -> Result<TcpStream, WebSocketClientError> {
    let authority = host_port(host, port);
    let addresses = tokio::net::lookup_host(authority)
        .await
        .map_err(|_| WebSocketClientError::ConnectionFailed)?
        .collect::<Vec<_>>();
    network.validate_resolved_addresses(&addresses)?;

    let connect = async {
        let mut last_error = None;
        for address in addresses {
            match TcpStream::connect(address).await {
                Ok(stream) => return Ok(stream),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| std::io::Error::other("no connection address")))
    };
    let stream = match network.timeouts().connect() {
        Timeout::Disabled => connect.await,
        Timeout::After(duration) => timeout(duration, connect)
            .await
            .map_err(|_| WebSocketClientError::ConnectionFailed)?,
    }
    .map_err(|_| WebSocketClientError::ConnectionFailed)?;
    if tcp_no_delay == TcpNoDelay::Enabled {
        stream
            .set_nodelay(true)
            .map_err(|_| WebSocketClientError::ConnectionFailed)?;
    }
    Ok(stream)
}

fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}
