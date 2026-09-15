//! Browser HTTP boundary. Service and workspace selection remain in the process host.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use http_body_util::Limited;
use hyper::Method;
use hyper::Request;
use hyper::Response;
use hyper::StatusCode;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use sha2::Digest;
use sha2::Sha256;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;

use crate::WebSocketReader;
use crate::WebSocketWriter;
use crate::websocket::serve_websocket;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const TICKET_LIFETIME: Duration = Duration::from_secs(5 * 60);
const SESSION_LIFETIME: Duration = Duration::from_secs(8 * 60 * 60);
const MAX_CONNECTIONS: usize = 128;
type Body = Full<Bytes>;

/// Options supplied exclusively through a trusted local launch connection.
pub struct BrowserOptions {
    pub port: u16,
    pub assets: Option<PathBuf>,
    pub origin: Option<String>,
    pub session_directory: Option<PathBuf>,
}

/// Listener lease. Dropping it closes connections; the launcher owns persisted authorization revocation.
pub struct BrowserListener {
    address: SocketAddr,
    ticket: String,
    shutdown: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<io::Result<()>>>,
}

impl BrowserListener {
    pub fn endpoint(&self) -> String {
        format!("http://{}/", self.address)
    }

    pub fn ticket(&self) -> &str {
        &self.ticket
    }

    pub async fn shutdown(mut self) -> io::Result<()> {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            task.await.map_err(io::Error::other)??;
        }
        Ok(())
    }
}

impl Drop for BrowserListener {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

struct Authority {
    ticket: Option<([u8; 32], Instant)>,
    sessions: BTreeMap<[u8; 32], SystemTime>,
    path: Option<PathBuf>,
}

impl Authority {
    fn exchange(&mut self, value: &str) -> io::Result<Option<String>> {
        self.sessions
            .retain(|_, expires| *expires > SystemTime::now());
        if self.sessions.len() >= 128 {
            return Ok(None);
        }
        let valid = self.ticket.as_ref().is_some_and(|(expected, expires)| {
            *expires > Instant::now() && constant_time_eq(expected, &digest(value))
        });
        if !valid {
            return Ok(None);
        }
        let token = random_token()?;
        self.ticket = None;
        self.sessions
            .insert(digest(&token), SystemTime::now() + SESSION_LIFETIME);
        self.save()?;
        Ok(Some(token))
    }

    fn authorize(&mut self, value: &str) -> bool {
        self.sessions
            .retain(|_, expires| *expires > SystemTime::now());
        let Some(expires) = self.sessions.get_mut(&digest(value)) else {
            return false;
        };
        *expires = SystemTime::now() + SESSION_LIFETIME;
        self.save().is_ok()
    }

    fn load(path: Option<PathBuf>, ticket: &str) -> io::Result<Self> {
        use std::io::Read;
        let mut authority = Self {
            ticket: Some((digest(ticket), Instant::now() + TICKET_LIFETIME)),
            sessions: BTreeMap::new(),
            path,
        };
        if let Some(path) = &authority.path {
            match std::fs::File::open(path) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(128 * 40 + 1).read_to_end(&mut bytes)?;
                    if bytes.len() > 128 * 40 || bytes.len() % 40 != 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Invalid Web session store",
                        ));
                    }
                    for entry in bytes.chunks_exact(40) {
                        let key: [u8; 32] = entry[..32].try_into().expect("fixed digest");
                        let seconds =
                            u64::from_le_bytes(entry[32..].try_into().expect("fixed timestamp"));
                        let expires = UNIX_EPOCH
                            .checked_add(Duration::from_secs(seconds))
                            .ok_or_else(|| {
                                io::Error::new(io::ErrorKind::InvalidData, "Invalid session expiry")
                            })?;
                        if expires > SystemTime::now() {
                            authority.sessions.insert(key, expires);
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(authority)
    }

    fn save(&self) -> io::Result<()> {
        use std::io::Write;
        let Some(path) = &self.path else {
            return Ok(());
        };
        std::fs::create_dir_all(path.parent().expect("session directory"))?;
        let temporary = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        for (key, expires) in &self.sessions {
            file.write_all(key)?;
            file.write_all(
                &expires
                    .duration_since(UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_secs()
                    .to_le_bytes(),
            )?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(temporary, path)
    }
}

/// Separates persisted Web authorization by profile, canonical workspace and development origin.
pub fn browser_session_directory(
    profile: &std::path::Path,
    workspace: &std::path::Path,
    origin: Option<&str>,
    lease_id: &[u8; 32],
) -> PathBuf {
    let scope = format!(
        "{}\n{}",
        workspace.display(),
        origin.unwrap_or("same-origin")
    );
    let key: String = digest(&scope)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let lease: String = lease_id.iter().map(|byte| format!("{byte:02x}")).collect();
    profile.join("web-sessions").join(key).join(lease)
}

struct Boundary {
    host: String,
    origin: String,
    assets: Option<PathBuf>,
    authority: Mutex<Authority>,
}

/// Starts an authenticated browser endpoint and a separately scoped JSONL connection per socket.
pub async fn start_browser_listener<H, M>(
    options: BrowserOptions,
    handler: H,
    metadata: M,
) -> io::Result<BrowserListener>
where
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
    M: Fn(String) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port)).await?;
    let address = listener.local_addr()?;
    let origin = options
        .origin
        .unwrap_or_else(|| format!("http://{address}"));
    validate_origin(&origin)?;
    let assets = options.assets.map(canonical_assets).transpose()?;
    let ticket = random_token()?;
    let boundary = Arc::new(Boundary {
        host: address.to_string(),
        origin,
        assets,
        authority: Mutex::new(Authority::load(
            options
                .session_directory
                .map(|directory| directory.join(format!("{}.session", address.port()))),
            &ticket,
        )?),
    });
    let (shutdown, mut stopping) = watch::channel(false);
    let handler = Arc::new(handler);
    let metadata = Arc::new(metadata);
    let task = tokio::spawn(async move {
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = stopping.changed() => break,
                accepted = listener.accept() => {
                    let (stream, peer) = accepted?;
                    if !peer.ip().is_loopback() { continue; }
                    let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else { continue; };
                    let boundary = Arc::clone(&boundary);
                    let handler = Arc::clone(&handler);
                    let metadata = Arc::clone(&metadata);
                    let stopped = stopping.clone();
                    connections.spawn(async move {
                        let permit = Arc::new(permit);
                        let service = service_fn(move |request| {
                            handle(request, Arc::clone(&boundary), Arc::clone(&handler), Arc::clone(&metadata), stopped.clone(), Arc::clone(&permit))
                        });
                        let mut builder = http1::Builder::new();
                        builder.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(HANDSHAKE_TIMEOUT).max_buf_size(32 * 1024);
                        let _ = builder.serve_connection(TokioIo::new(stream), service).with_upgrades().await;
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        Ok(())
    });
    Ok(BrowserListener {
        address,
        ticket,
        shutdown,
        task: Some(task),
    })
}

async fn handle<H, M>(
    mut request: Request<Incoming>,
    boundary: Arc<Boundary>,
    handler: Arc<H>,
    metadata: Arc<M>,
    stopping: watch::Receiver<bool>,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Response<Body>, Infallible>
where
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
    M: Fn(String) -> String + Send + Sync + 'static,
{
    if header(&request, "host") != Some(boundary.host.as_str()) {
        return Ok(response(StatusCode::FORBIDDEN, "Invalid host"));
    }
    if !request.uri().path().starts_with("/ash/") {
        return Ok(static_response(&request, &boundary).await);
    }
    if header(&request, "origin") != Some(boundary.origin.as_str())
        || request.uri().query().is_some()
    {
        return Ok(response(StatusCode::FORBIDDEN, "Invalid origin"));
    }
    let result = if request.method() == Method::OPTIONS && request.uri().path() == "/ash/session" {
        let mut result = response(StatusCode::NO_CONTENT, "");
        result.headers_mut().insert(
            "access-control-allow-methods",
            "POST, GET".parse().expect("static header"),
        );
        result.headers_mut().insert(
            "access-control-allow-headers",
            "authorization, content-type"
                .parse()
                .expect("static header"),
        );
        result
    } else if request.uri().path() == "/ash/session" && request.method() == Method::POST {
        let session = header(&request, "authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned);
        let body = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            Limited::new(request.into_body(), 1024).collect(),
        )
        .await;
        match body {
            Ok(Ok(body)) => {
                let bytes = body.to_bytes();
                let token = match session {
                    Some(token) if bytes.is_empty() && authorized(&boundary, &token) => Some(token),
                    Some(_) => None,
                    None => std::str::from_utf8(&bytes).ok().and_then(|ticket| {
                        boundary
                            .authority
                            .lock()
                            .ok()?
                            .exchange(ticket)
                            .ok()
                            .flatten()
                    }),
                };
                match token {
                    Some(token) => json_response(metadata(token)),
                    None => response(StatusCode::UNAUTHORIZED, "Invalid or expired launch ticket"),
                }
            }
            _ => response(StatusCode::BAD_REQUEST, "Invalid authentication request"),
        }
    } else if request.uri().path() == "/ash/session" && request.method() == Method::GET {
        match header(&request, "authorization").and_then(|value| value.strip_prefix("Bearer ")) {
            Some(token) if authorized(&boundary, token) => {
                json_response(metadata(token.to_owned()))
            }
            _ => response(StatusCode::UNAUTHORIZED, "Session expired"),
        }
    } else if request.uri().path() == "/ash/app-server" && request.method() == Method::GET {
        let protocol = header(&request, "sec-websocket-protocol")
            .unwrap_or("")
            .to_owned();
        let valid = protocol
            .strip_prefix("ash-session.")
            .is_some_and(|token| authorized(&boundary, token));
        let key = header(&request, "sec-websocket-key").map(str::to_owned);
        if !valid {
            response(StatusCode::UNAUTHORIZED, "Session expired")
        } else if header(&request, "upgrade")
            .is_none_or(|value| !value.eq_ignore_ascii_case("websocket"))
            || header(&request, "connection").is_none_or(|value| {
                !value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
            })
            || header(&request, "sec-websocket-version") != Some("13")
            || key.is_none()
        {
            response(StatusCode::BAD_REQUEST, "Invalid WebSocket handshake")
        } else {
            let accept = derive_accept_key(key.as_deref().expect("checked key").as_bytes());
            tokio::spawn(async move {
                let _permit = permit;
                if let Ok(Ok(upgraded)) =
                    tokio::time::timeout(HANDSHAKE_TIMEOUT, hyper::upgrade::on(&mut request)).await
                {
                    let socket = WebSocketStream::from_raw_socket(
                        TokioIo::new(upgraded),
                        Role::Server,
                        None,
                    )
                    .await;
                    serve_websocket(socket, handler, stopping).await;
                }
            });
            Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header("upgrade", "websocket")
                .header("connection", "Upgrade")
                .header("sec-websocket-accept", accept)
                .header("sec-websocket-protocol", protocol)
                .body(Full::new(Bytes::new()))
                .expect("validated handshake")
        }
    } else {
        response(StatusCode::NOT_FOUND, "Not found")
    };
    let mut result = result;
    result.headers_mut().insert(
        "access-control-allow-origin",
        boundary.origin.parse().expect("validated origin"),
    );
    result
        .headers_mut()
        .insert("vary", "Origin".parse().expect("static header"));
    Ok(result)
}

fn authorized(boundary: &Boundary, token: &str) -> bool {
    token.len() == 64
        && boundary
            .authority
            .lock()
            .is_ok_and(|mut authority| authority.authorize(token))
}

async fn static_response(request: &Request<Incoming>, boundary: &Boundary) -> Response<Body> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return response(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(root) = &boundary.assets else {
        return response(StatusCode::NOT_FOUND, "Not found");
    };
    if request.uri().path() == "/" {
        let mut result = response(StatusCode::FOUND, "");
        result.headers_mut().insert(
            "location",
            "/browser/workbench/workbench.html"
                .parse()
                .expect("static path"),
        );
        return result;
    }
    let Ok(path) = urlencoding::decode(request.uri().path()) else {
        return response(StatusCode::BAD_REQUEST, "Invalid path");
    };
    let relative = path.trim_start_matches('/');
    if relative
        .split('/')
        .any(|part| part.starts_with('.') || part.contains(['\\', ':', '\0']))
    {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    let Ok(file) = tokio::fs::canonicalize(root.join(relative)).await else {
        return response(StatusCode::NOT_FOUND, "Not found");
    };
    if !file.starts_with(root) {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    let Ok(info) = tokio::fs::metadata(&file).await else {
        return response(StatusCode::NOT_FOUND, "Not found");
    };
    if !info.is_file() || info.len() > 64 * 1024 * 1024 {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    let content = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        match tokio::fs::read(&file).await {
            Ok(content) => content,
            Err(_) => return response(StatusCode::NOT_FOUND, "Not found"),
        }
    };
    let mime = match file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header("content-type", mime)
        .header("content-length", info.len())
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-cache")
        .body(Full::new(Bytes::from(content)))
        .expect("static response")
}

fn response(status: StatusCode, text: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Full::new(Bytes::copy_from_slice(text.as_bytes())))
        .expect("static response")
}

fn json_response(text: String) -> Response<Body> {
    let mut result = response(StatusCode::OK, &text);
    result.headers_mut().insert(
        "content-type",
        "application/json".parse().expect("static header"),
    );
    result
}

fn header<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    request.headers().get(name)?.to_str().ok()
}

fn validate_origin(value: &str) -> io::Result<()> {
    let url = url::Url::parse(value).map_err(io::Error::other)?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Web origin must be an exact loopback HTTP origin",
        ));
    }
    Ok(())
}

fn canonical_assets(path: PathBuf) -> io::Result<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Web assets must be a directory",
        ));
    }
    Ok(path)
}

fn random_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0, |different, (left, right)| different | (left ^ right))
        == 0
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
