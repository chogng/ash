use super::*;
use futures::SinkExt;
use futures::StreamExt;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[test]
fn authenticates_browser_sessions_and_preserves_independent_connections() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let calls = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::clone(&calls);
        let listener = start_browser_listener(
            BrowserOptions {
                session_directory: None,
                port: 0,
                assets: None,
                origin: None,
            },
            move |reader, mut writer| {
                accepted.fetch_add(1, Ordering::Relaxed);
                for line in std::io::BufReader::new(reader).lines() {
                    let Ok(line) = line else {
                        break;
                    };
                    if writeln!(writer, "{line}").is_err() {
                        break;
                    }
                }
            },
            |token| serde_json::json!({ "token": token, "workspaceRoot": "allowed" }).to_string(),
        )
        .await
        .unwrap();
        let origin = format!("http://{}", listener.address);
        let ticket = listener.ticket();
        let denied = request(
            listener.address,
            "POST",
            "/ash/session",
            "http://evil.test",
            "",
            ticket,
        );
        assert!(denied.starts_with("HTTP/1.1 403"));
        let response = request(
            listener.address,
            "POST",
            "/ash/session",
            &origin,
            "",
            ticket,
        );
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let metadata: serde_json::Value =
            serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let token = metadata["token"].as_str().unwrap();
        assert_eq!(metadata["workspaceRoot"], "allowed");
        let replay = request(
            listener.address,
            "POST",
            "/ash/session",
            &origin,
            "",
            ticket,
        );
        assert!(replay.starts_with("HTTP/1.1 401"));
        let resume = request(
            listener.address,
            "GET",
            "/ash/session",
            &origin,
            &format!("Authorization: Bearer {token}\r\n"),
            "",
        );
        assert!(resume.starts_with("HTTP/1.1 200"));
        let url = format!("ws://{}/ash/app-server", listener.address);
        let make_request = |origin: &str, token: &str| {
            let mut request = url.as_str().into_client_request().unwrap();
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            request.headers_mut().insert(
                "sec-websocket-protocol",
                format!("ash-session.{token}").parse().unwrap(),
            );
            request
        };
        assert!(
            tokio_tungstenite::client_async(
                make_request("http://evil.test", token),
                tokio::net::TcpStream::connect(listener.address)
                    .await
                    .unwrap()
            )
            .await
            .is_err()
        );
        assert!(
            tokio_tungstenite::client_async(
                make_request(&origin, "invalid"),
                tokio::net::TcpStream::connect(listener.address)
                    .await
                    .unwrap()
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let (mut first, _) = tokio_tungstenite::client_async(
            make_request(&origin, token),
            tokio::net::TcpStream::connect(listener.address)
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        let (mut second, _) = tokio_tungstenite::client_async(
            make_request(&origin, token),
            tokio::net::TcpStream::connect(listener.address)
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        first.send(Message::Text("first".into())).await.unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap().into_text().unwrap(),
            "first"
        );
        first.close(None).await.unwrap();
        second.send(Message::Text("second".into())).await.unwrap();
        assert_eq!(
            second.next().await.unwrap().unwrap().into_text().unwrap(),
            "second"
        );
        listener.shutdown().await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), second.next())
            .await
            .unwrap();
        assert!(!matches!(closed, Some(Ok(Message::Text(_)))));
    });
}

#[test]
fn static_assets_cannot_escape_the_launch_root_or_accept_another_host() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("web");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.js"), "export const ready = true;").unwrap();
    std::fs::write(directory.path().join("secret.txt"), "private").unwrap();
    runtime.block_on(async {
        let listener = start_browser_listener(
            BrowserOptions {
                session_directory: None,
                port: 0,
                assets: Some(root),
                origin: None,
            },
            |_, _| {},
            |_| String::new(),
        )
        .await
        .unwrap();
        let origin = format!("http://{}", listener.address);
        let asset = request(listener.address, "GET", "/main.js", &origin, "", "");
        assert!(asset.starts_with("HTTP/1.1 200"));
        assert!(asset.contains("text/javascript"));
        for path in [
            "/../secret.txt",
            "/%2e%2e/secret.txt",
            "/%2e%2e%5csecret.txt",
            "/C%3A/secret.txt",
        ] {
            let response = request(listener.address, "GET", path, &origin, "", "");
            assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
            assert!(!response.contains("private"));
        }
        let mut socket = std::net::TcpStream::connect(listener.address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .write_all(b"GET /main.js HTTP/1.1\r\nHost: attacker.test\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut rejected = String::new();
        socket.read_to_string(&mut rejected).unwrap();
        assert!(rejected.starts_with("HTTP/1.1 403"));
        listener.shutdown().await.unwrap();
    });
}

#[test]
fn expired_tickets_and_sessions_cannot_be_used() {
    let mut authority = Authority {
        ticket: Some((digest("ticket"), Instant::now() - Duration::from_secs(1))),
        sessions: BTreeMap::new(),
        path: None,
    };
    assert!(authority.exchange("ticket").unwrap().is_none());
    authority.sessions.insert(
        digest("session"),
        SystemTime::now() - Duration::from_secs(1),
    );
    assert!(!authority.authorize("session"));
    assert!(validate_origin("http://127.0.0.1:5173").is_ok());
    for origin in [
        "http://evil.test",
        "http://127.0.0.1:5173/path",
        "http://user@127.0.0.1:5173",
        "null",
    ] {
        assert!(validate_origin(origin).is_err());
    }
}

#[test]
fn sessions_survive_backend_restart_but_not_revocation_or_workspace_changes() {
    let root = tempfile::tempdir().unwrap();
    let directory = browser_session_directory(
        root.path(),
        std::path::Path::new("workspace-a"),
        None,
        &[1; 32],
    );
    assert_ne!(
        directory,
        browser_session_directory(
            root.path(),
            std::path::Path::new("workspace-a"),
            None,
            &[2; 32]
        )
    );
    let path = directory.join("5174.session");
    let mut first = Authority::load(Some(path.clone()), "initial-ticket").unwrap();
    let token = first.exchange("initial-ticket").unwrap().unwrap();
    let stored = std::fs::read(&path).unwrap();
    assert!(
        !stored
            .windows(token.len())
            .any(|bytes| bytes == token.as_bytes())
    );
    drop(first);
    let mut restored = Authority::load(Some(path.clone()), "new-ticket").unwrap();
    assert!(restored.authorize(&token));
    assert!(restored.exchange("initial-ticket").unwrap().is_none());
    std::fs::remove_file(&path).unwrap();
    let mut revoked = Authority::load(Some(path), "another-ticket").unwrap();
    assert!(!revoked.authorize(&token));
    assert_ne!(
        directory,
        browser_session_directory(
            root.path(),
            std::path::Path::new("workspace-b"),
            None,
            &[1; 32]
        )
    );
    assert_ne!(
        directory,
        browser_session_directory(
            root.path(),
            std::path::Path::new("workspace-a"),
            Some("http://127.0.0.1:5173"),
            &[1; 32],
        )
    );
}

fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    origin: &str,
    headers: &str,
    body: &str,
) -> String {
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(socket, "{method} {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    response
}
