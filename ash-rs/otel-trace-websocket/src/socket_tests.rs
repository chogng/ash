use super::*;
use crate::tests::TOKEN;
use crate::tests::exporter;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[tokio::test]
async fn handshake_rejects_missing_wrong_and_url_credentials() {
    let exporter = exporter();
    let wrong = format!("Bearer {}", "00".repeat(32));
    for (path, authorization) in [
        ("/", None),
        ("/", Some("Bearer incorrect")),
        ("/", Some(wrong.as_str())),
        ("/?token=secret", Some(TOKEN)),
        ("/other", Some(TOKEN)),
    ] {
        let stream = TcpStream::connect(exporter.local_addr()).await.unwrap();
        let mut request = format!("ws://{}{path}", exporter.local_addr())
            .into_client_request()
            .unwrap();
        if let Some(authorization) = authorization {
            let authorization = if authorization == TOKEN {
                format!("Bearer {TOKEN}")
            } else {
                authorization.into()
            };
            request
                .headers_mut()
                .insert("authorization", authorization.parse().unwrap());
        }
        let error = tokio_tungstenite::client_async(request, stream)
            .await
            .unwrap_err();
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("unexpected error: {error}")
        };
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!format!("{response:?}").contains(TOKEN));
    }
}

#[tokio::test]
async fn browser_authentication_selects_only_the_public_protocol() {
    let exporter = exporter();
    let stream = TcpStream::connect(exporter.local_addr()).await.unwrap();
    let mut request = format!("ws://{}/", exporter.local_addr())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", "http://localhost:3000".parse().unwrap());
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("{PROTOCOL}, {TOKEN_PREFIX}{TOKEN}")
            .parse()
            .unwrap(),
    );
    let (mut viewer, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], PROTOCOL);
    assert!(!format!("{response:?}").contains(TOKEN));
    assert!(
        viewer
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("ready")
    );
}

#[tokio::test]
async fn bounded_stream_reports_loss_to_a_slow_viewer() {
    // Do not poll the connection task while filling the ring: deterministic backpressure.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (frames, _) = broadcast::channel(crate::BUFFER_FRAMES);
    let client_stream = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server_stream, _) = listener.accept().await.unwrap();
    let (release, wait) = tokio::sync::oneshot::channel();
    let mut request = format!("ws://{}/", listener.local_addr().unwrap())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let client = async {
        let (mut viewer, _) = tokio_tungstenite::client_async(request, client_stream)
            .await
            .unwrap();
        viewer.next().await.unwrap().unwrap(); // ready means the receiver is registered.
        for index in 0..crate::BUFFER_FRAMES + 7 {
            frames.send(Arc::from(format!("span-{index}"))).unwrap();
        }
        release.send(()).unwrap();
        let frame = viewer.next().await.unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"type":"lagged","dropped":7}));
    };
    let server = async {
        let task = connection(server_stream, TOKEN.parse().unwrap(), frames.clone());
        tokio::pin!(task);
        // The client branch has no yield between ready and publishing the whole batch.
        tokio::select! { _ = &mut task => panic!("connection ended early"), _ = wait => {} }
        task.await;
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(client, server);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn connection_limit_closes_the_extra_socket() {
    let exporter = exporter();
    let mut viewers = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let stream = TcpStream::connect(exporter.local_addr()).await.unwrap();
        let mut request = format!("ws://{}/", exporter.local_addr())
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let (mut viewer, _) = tokio_tungstenite::client_async(request, stream)
            .await
            .unwrap();
        viewer.next().await.unwrap().unwrap();
        viewers.push(viewer);
    }
    let stream = TcpStream::connect(exporter.local_addr()).await.unwrap();
    let extra = tokio_tungstenite::client_async(format!("ws://{}/", exporter.local_addr()), stream);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), extra)
            .await
            .unwrap()
            .is_err()
    );
}
