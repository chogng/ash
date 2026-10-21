use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

#[derive(Default)]
struct Credential {
    refreshes: AtomicUsize,
}
impl HttpCredentialProvider for Credential {
    fn bearer(&self, rejected: Option<&str>) -> Result<String, std::io::Error> {
        if rejected == Some("old") {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            return Ok("fresh".into());
        }
        Ok("old".into())
    }
}

#[tokio::test]
async fn http_retries_one_definitive_401_with_fresh_credentials_but_never_retries_403() {
    for status in [401, 403] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri: Arc<str> = format!("http://{}/mcp", listener.local_addr().unwrap()).into();
        let credential = Arc::new(Credential::default());
        let server = tokio::spawn(async move {
            for attempt in 0..if status == 401 { 2 } else { 1 } {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    let text = std::str::from_utf8(&request).unwrap();
                    if let Some(header_end) = text.find("\r\n\r\n") {
                        let length = text[..header_end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|value| value.parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.contains(if attempt == 0 {
                    "authorization: bearer old"
                } else {
                    "authorization: bearer fresh"
                }));
                let response = if attempt == 0 {
                    format!(
                        "HTTP/1.1 {status} Denied\r\nWWW-Authenticate: Bearer error=\"invalid_token\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else {
                    let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = AuthenticatedClient {
            client: ash_http_client::ReqwestHttpClient::sdk_client_builder()
                .unwrap()
                .build()
                .unwrap(),
            credentials: Some(credential.clone()),
        };
        let message =
            serde_json::from_value(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
                .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.post_message(uri, message, None, None, HashMap::new()),
        )
        .await
        .unwrap();
        assert_eq!(result.is_ok(), status == 401);
        assert_eq!(
            credential.refreshes.load(Ordering::SeqCst),
            usize::from(status == 401)
        );
        server.await.unwrap();
    }
}

struct ScopedCredential(Arc<HttpCredentialScope>);
impl HttpCredentialProvider for ScopedCredential {
    fn bearer(&self, _: Option<&str>) -> Result<String, std::io::Error> {
        Ok("scoped".into())
    }
    fn scope(&self) -> Option<Arc<HttpCredentialScope>> {
        Some(Arc::clone(&self.0))
    }
}

#[tokio::test]
async fn retirement_cancels_http_headers_and_get_and_post_sse_bodies_without_replay() {
    for (post, headers) in [(true, false), (false, false), (true, true), (false, true)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri: Arc<str> = format!("http://{}/mcp", listener.local_addr().unwrap()).into();
        let scope = Arc::new(HttpCredentialScope::default());
        let client = AuthenticatedClient {
            client: ash_http_client::ReqwestHttpClient::sdk_client_builder()
                .unwrap()
                .build()
                .unwrap(),
            credentials: Some(Arc::new(ScopedCredential(scope.clone()))),
        };
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0_u8; 4096];
            let mut request = Vec::new();
            loop {
                let n = socket.read(&mut bytes).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&bytes[..n]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            assert!(String::from_utf8_lossy(&request).contains("Bearer scoped"));
            if headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await.unwrap();
            }
            entered.send(()).unwrap();
            // Cancellation must drop the request/body, not merely stop forwarding results.
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    match socket.read(&mut bytes).await {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                        Err(error) => panic!("waiting for retired HTTP body: {error}"),
                    }
                }
            })
            .await
            .unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
        });
        let (stream_ready, stream_waiting) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(async move {
            let response = if post {
                let message = serde_json::from_value(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write","arguments":{}}})).unwrap();
                client
                    .post_message(uri, message, None, None, HashMap::new())
                    .await
                    .map(|response| match response {
                        StreamableHttpPostResponse::Sse(stream, _) => stream,
                        response => panic!("unexpected response {response:?}"),
                    })
            } else {
                client
                    .get_stream(uri, Some(Arc::from("session")), None, None, HashMap::new())
                    .await
            };
            if headers {
                let mut stream = response.unwrap();
                stream_ready.send(()).unwrap();
                assert!(stream.next().await.is_none());
            } else {
                assert!(response.is_err());
            }
        });
        waiting.await.unwrap();
        if headers {
            stream_waiting.await.unwrap();
        }
        scope.close();
        tokio::time::timeout(std::time::Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap();
        let retired = scope.clone();
        tokio::task::spawn_blocking(move || retired.drain(std::time::Duration::from_secs(1)))
            .await
            .unwrap()
            .unwrap();
        assert!(scope.acquire().is_none());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn an_uncertain_write_is_not_replayed() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let uri: Arc<str> = format!("http://{}/mcp", listener.local_addr().unwrap()).into();
    let credential = Arc::new(Credential::default());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        drop(socket);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    let client = AuthenticatedClient {
        client: ash_http_client::ReqwestHttpClient::sdk_client_builder()
            .unwrap()
            .build()
            .unwrap(),
        credentials: Some(credential.clone()),
    };
    let message =
        serde_json::from_value(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .unwrap();
    assert!(
        client
            .post_message(uri, message, None, None, HashMap::new())
            .await
            .is_err()
    );
    assert_eq!(credential.refreshes.load(Ordering::SeqCst), 0);
    server.await.unwrap();
}

#[tokio::test]
async fn retirement_ends_a_real_rmcp_tool_call_before_its_request_deadline() {
    use crate::CallToolRequestParams;
    use crate::RmcpClient;
    use crate::RmcpClientOptions;
    use crate::StreamableHttpServer;
    use tokio::io::AsyncBufReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let uri = format!("http://{}/mcp", listener.local_addr().unwrap());
    let lifetime = Arc::new(HttpCredentialScope::default());
    let credential = Arc::new(ScopedCredential(lifetime.clone()));
    let (started, mut calls) = tokio::sync::mpsc::unbounded_channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        tokio::pin!(stopped);
        loop {
            let (socket, _) = tokio::select! {
                _ = &mut stopped => break,
                socket = listener.accept() => socket.unwrap(),
            };
            let started = started.clone();
            handlers.spawn(async move {
                let mut reader = tokio::io::BufReader::new(socket);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let get = line.starts_with("GET ");
                let mut length = 0;
                loop {
                    line.clear(); reader.read_line(&mut line).await.unwrap();
                    if line == "\r\n" { break; }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length: ") { length = value.trim().parse().unwrap(); }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).await.unwrap();
                let request: serde_json::Value = if body.is_empty() { serde_json::Value::Null } else { serde_json::from_slice(&body).unwrap() };
                let method = request["method"].as_str();
                if get || method == Some("tools/call") {
                    reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    if !get { started.send(()).unwrap(); }
                    let mut bytes = [0; 1024];
                    loop {
                        match reader.read(&mut bytes).await {
                            Ok(0) => break,
                            Ok(_) => {},
                            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                            Err(error) => panic!("waiting for retired RMCP body: {error}"),
                        }
                    }
                } else if method == Some("initialize") {
                    let result = serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"retirement-fixture","version":"1"}}}).to_string();
                    reader.get_mut().write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{result}",result.len()).as_bytes()).await.unwrap();
                } else {
                    assert_eq!(method, Some("notifications/initialized"));
                    reader.get_mut().write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                }
            });
        }
        while let Some(result) = handlers.join_next().await {
            result.unwrap();
        }
    });
    let client = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        RmcpClient::connect_streamable_http(
            StreamableHttpServer::new(uri)
                .unwrap()
                .with_credentials(credential),
            RmcpClientOptions::new("test", "1"),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    {
        let call = client.call_tool(CallToolRequestParams::new("write"));
        tokio::pin!(call);
        tokio::select! {
            result = &mut call => panic!("tool finished before retirement: {result:?}"),
            _ = calls.recv() => {}
        }
        lifetime.close();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), &mut call)
                .await
                .unwrap()
                .is_err()
        );
    }
    drop(client);
    let retired = lifetime.clone();
    tokio::task::spawn_blocking(move || retired.drain(std::time::Duration::from_secs(2)))
        .await
        .unwrap()
        .unwrap();
    assert!(calls.try_recv().is_err());
    stop.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
