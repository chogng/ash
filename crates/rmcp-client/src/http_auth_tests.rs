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
