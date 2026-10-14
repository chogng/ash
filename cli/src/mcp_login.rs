//! CLI-owned loopback interaction. The shared backend owns tokens, refresh and logout.
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_client::McpOAuthCompleteRequest;
use ash_app_server_protocol::protocol::mcp::McpOAuthCancelParams;
use ash_app_server_protocol::protocol::mcp::McpOAuthStartParams;

use crate::CliError;
use crate::InterruptSignal;
use crate::management;
use crate::nls;
use crate::print_json;

pub(super) fn run(
    id: String,
    client_id: Option<String>,
    client_metadata_url: Option<String>,
    scopes: Vec<String>,
) -> Result<(), CliError> {
    let interrupt = InterruptSignal::register()?;
    management::with_client(|client| {
        let config = client.read_config()?;
        let server = config
            .mcp_servers
            .get(&id)
            .ok_or_else(|| CliError::usage(nls::text(nls::Message::McpHttpOnly)))?;
        let ash_app_server_protocol::protocol::config::McpTransportDto::StreamableHttp { url } =
            &server.transport
        else {
            return Err(CliError::usage(nls::text(nls::Message::McpHttpOnly)));
        };
        use sha2::Digest;
        let endpoint = url::Url::parse(url).map_err(CliError::failure)?;
        let path = format!(
            "/mcp-oauth/{:x}/callback",
            sha2::Sha256::digest(endpoint.as_str().as_bytes())
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(CliError::failure)?;
        listener.set_nonblocking(true).map_err(CliError::failure)?;
        let redirect = format!(
            "http://127.0.0.1:{}{path}",
            listener.local_addr().map_err(CliError::failure)?.port()
        );
        eprintln!("{}", nls::format(nls::Message::McpCallbackUrl, &redirect));
        sign_in(
            client,
            McpOAuthStartParams {
                server_id: id,
                redirect_uri: redirect,
                client_id,
                client_metadata_url,
                scopes,
            },
            &listener,
            &interrupt,
            open_browser,
        )
    })
}

fn sign_in<T: ash_app_server_client::JsonRpcTransport>(
    client: &mut ash_app_server_client::AppServerClient<T>,
    params: McpOAuthStartParams,
    listener: &TcpListener,
    interrupt: &InterruptSignal,
    open: impl FnOnce(&str),
) -> Result<(), CliError> {
    let redirect = params.redirect_uri.clone();
    let callback_url = url::Url::parse(&redirect).map_err(CliError::failure)?;
    let path = callback_url.path();
    let started = client.start_mcp_oauth(params)?;
    eprintln!(
        "{}",
        nls::format(nls::Message::McpLoginUrl, &started.authorization_url)
    );
    open(&started.authorization_url);
    let outcome = (|| {
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            if interrupt.cancellation().load(Ordering::SeqCst) || Instant::now() >= deadline {
                return Err(CliError::failure(nls::text(
                    nls::Message::McpLoginCancelled,
                )));
            }
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(error) => return Err(CliError::failure(error)),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(CliError::failure)?;
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .map_err(CliError::failure)?;
            let mut buffer = zeroize::Zeroizing::new(Vec::new());
            // Read only the bounded request header. Never wait for a browser to close keep-alive.
            let mut byte = [0_u8; 1];
            let header_deadline = Instant::now() + Duration::from_secs(2);
            while buffer.len() < 8192 && !buffer.ends_with(b"\r\n\r\n") {
                let remaining = header_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() || interrupt.cancellation().load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(remaining))
                    .map_err(CliError::failure)?;
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                buffer.push(byte[0]);
            }
            let request = std::str::from_utf8(&buffer).unwrap_or_default();
            let Some((state, code, issuer)) = callback(request, &redirect, path) else {
                let _ = stream.write_all(
                    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                );
                continue;
            };
            let completed = client.complete_mcp_oauth(McpOAuthCompleteRequest::new(
                started.flow_id.clone(),
                state,
                code,
                issuer,
            ));
            let (status, body) = if completed.is_ok() {
                ("200 OK", nls::text(nls::Message::McpCallbackComplete))
            } else {
                (
                    "400 Bad Request",
                    nls::text(nls::Message::McpCallbackInvalid),
                )
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            return print_json(&completed?);
        }
    })();
    if outcome.is_err() {
        let _ = client.cancel_mcp_oauth(McpOAuthCancelParams {
            flow_id: started.flow_id,
        });
    }
    outcome
}

fn callback(request: &str, redirect: &str, path: &str) -> Option<(String, String, Option<String>)> {
    if !request.ends_with("\r\n\r\n") {
        return None;
    }
    let mut fields = request.lines().next()?.split_whitespace();
    if fields.next()? != "GET" {
        return None;
    }
    let target = fields.next()?;
    if !target.starts_with('/') || target.starts_with("//") {
        return None;
    }
    let url = url::Url::parse(redirect).ok()?.join(target).ok()?;
    if url.path() != path {
        return None;
    }
    let mut state = None;
    let mut code = None;
    let mut issuer = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" if state.is_none() && !value.is_empty() => state = Some(value.into_owned()),
            "code" if code.is_none() && !value.is_empty() => code = Some(value.into_owned()),
            "iss" if issuer.is_none() && !value.is_empty() => issuer = Some(value.into_owned()),
            "state" | "code" | "iss" | "error" => return None,
            _ => {}
        }
    }
    Some((state?, code?, issuer))
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .spawn();
    if let Ok(mut child) = result {
        let _ = std::thread::Builder::new()
            .name("ash-mcp-browser".into())
            .spawn(move || {
                let _ = child.wait();
            });
    }
}

#[cfg(test)]
#[path = "mcp_login_tests.rs"]
mod tests;
