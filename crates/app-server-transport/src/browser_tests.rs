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
                workspace: None,
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
fn workspace_control_requires_an_authenticated_same_origin_session() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let listener = start_browser_listener(
            BrowserOptions {
                session_directory: None,
                workspace: Some(BrowserWorkspaceOperations {
                    list: Arc::new(|body| Box::pin(async move { Ok(body) })),
                    open: Arc::new(|_| {
                        Box::pin(async {
                            Err(io::Error::new(
                                io::ErrorKind::PermissionDenied,
                                "Approval required",
                            ))
                        })
                    }),
                }),
                port: 0,
                assets: None,
                origin: None,
            },
            |_, _| {},
            |token| serde_json::json!({ "token": token }).to_string(),
        )
        .await
        .unwrap();
        let origin = format!("http://{}", listener.address);
        let body = r#"{"path":"/chosen"}"#;
        let unauthorized = request(
            listener.address,
            "POST",
            "/ash/workspace/list",
            &origin,
            "",
            body,
        );
        assert!(unauthorized.starts_with("HTTP/1.1 401"));
        let exchanged = request(
            listener.address,
            "POST",
            "/ash/session",
            &origin,
            "",
            listener.ticket(),
        );
        let metadata: serde_json::Value =
            serde_json::from_str(exchanged.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let authorization = format!(
            "Authorization: Bearer {}\r\n",
            metadata["token"].as_str().unwrap()
        );
        let foreign = request(
            listener.address,
            "POST",
            "/ash/workspace/list",
            "http://evil.test",
            &authorization,
            body,
        );
        assert!(foreign.starts_with("HTTP/1.1 403"));
        let listing = request(
            listener.address,
            "POST",
            "/ash/workspace/list",
            &origin,
            &authorization,
            body,
        );
        assert!(listing.starts_with("HTTP/1.1 200"));
        assert_eq!(listing.split("\r\n\r\n").nth(1), Some(body));
        let denied = request(
            listener.address,
            "POST",
            "/ash/workspace/open",
            &origin,
            &authorization,
            body,
        );
        assert!(denied.starts_with("HTTP/1.1 403"));
        listener.shutdown().await.unwrap();
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
                workspace: None,
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
fn isolated_webview_hosts_receive_only_bootstrap_assets() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let assets = directory.path().join("assets");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index-test.html"), "bootstrap").unwrap();
    std::fs::write(assets.join("service-worker-test.js"), "worker").unwrap();
    std::fs::write(assets.join("main.js"), "product").unwrap();
    runtime.block_on(async {
        let listener = start_browser_listener(
            BrowserOptions {
                session_directory: None,
                workspace: None,
                port: 0,
                assets: Some(directory.path().to_owned()),
                origin: None,
            },
            |_, _| panic!("An isolated webview must never open a product connection"),
            |_| panic!("An isolated webview must never acquire a product session"),
        )
        .await
        .unwrap();
        let host = format!(
            "550e8400-e29b-41d4-a716-446655440000.localhost:{}",
            listener.address.port()
        );
        let request = |host: &str, method: &str, path: &str| {
            let mut socket = std::net::TcpStream::connect(listener.address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            write!(socket, "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            response
        };
        let bootstrap = request(&host, "GET", "/assets/index-test.html?worker=isolated");
        assert!(bootstrap.starts_with("HTTP/1.1 200"));
        assert!(bootstrap.ends_with("bootstrap"));
        let worker = request(&host, "GET", "/assets/service-worker-test.js");
        assert!(worker.starts_with("HTTP/1.1 200"));
        assert!(worker.contains("text/javascript"));
        assert!(worker.ends_with("worker"));
        for path in [
            "/",
            "/browser/workbench/workbench.html",
            "/assets/main.js",
            "/assets/index-test.html/../main.js",
            "/assets/index-%2e%2e.html",
            "/ash/session",
            "/ash/workspace/list",
            "/ash/workspace/open",
            "/ash/app-server",
        ] {
            for method in ["GET", "POST"] {
                let denied = request(&host, method, path);
                assert!(denied.starts_with("HTTP/1.1 403"), "{method} {path}: {denied}");
            }
        }
        assert!(request(&host, "POST", "/assets/index-test.html").starts_with("HTTP/1.1 405"));
        for other_host in [
            format!("not-a-uuid.localhost:{}", listener.address.port()),
            "550e8400-e29b-41d4-a716-446655440000.localhost:0".to_owned(),
            format!("550e8400-e29b-41d4-a716-446655440000.attacker.test:{}", listener.address.port()),
        ] {
            assert!(request(&other_host, "GET", "/assets/index-test.html").starts_with("HTTP/1.1 403"));
        }
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
