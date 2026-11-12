use super::TcpAuthorization;
use super::TcpStreams;
use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[test]
fn tcp_streams_preserve_half_close_and_retire_connection_resources() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let echo = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut input = Vec::new();
        socket.read_to_end(&mut input).unwrap();
        assert_eq!(input, b"request");
        socket.write_all(b"response after FIN").unwrap();
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let destination =
        crate::NetworkRequest::new(crate::NetworkProtocol::Socks5Tcp, "localhost", port).unwrap();
    let streams = TcpStreams::default();
    runtime
        .block_on(streams.open(
            "test".into(),
            &destination,
            Arc::new(Authorization::default()),
        ))
        .unwrap();
    assert_eq!(streams.write("test", b"request").unwrap(), 7);
    streams.end("test").unwrap();
    let mut received = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (bytes, eof) = streams.read("test").unwrap();
        received.extend(bytes);
        if eof {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(received, b"response after FIN");
    assert!(TcpStreams::default().read("test").is_err());
    streams.close_all();
    assert!(streams.read("test").is_err());
    assert!(
        runtime
            .block_on(streams.open(
                "late".into(),
                &destination,
                Arc::new(Authorization::default())
            ))
            .is_err()
    );
    echo.join().unwrap();
}

#[derive(Debug, Default)]
struct Authorization(ash_async_utils::CancellationSource, AtomicBool);

impl TcpAuthorization for Authorization {
    fn check(&self) -> std::io::Result<()> {
        self.0
            .token()
            .check()
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::PermissionDenied))?;
        // Model being descheduled immediately after a successful checkpoint while a
        // concurrent policy update revokes the permit before the syscall begins.
        if self.1.swap(false, Ordering::SeqCst) {
            self.0.cancel();
        }
        Ok(())
    }

    fn revoked(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {
            self.0.token().cancelled().await;
        })
    }
}

#[test]
fn tcp_revocation_rejects_operations_queued_on_the_socket() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let destination = crate::NetworkRequest::new(
        crate::NetworkProtocol::Socks5Tcp,
        "127.0.0.1",
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let streams = Arc::new(TcpStreams::default());
    let authorization = Arc::new(Authorization::default());
    runtime
        .block_on(streams.open("queued".into(), &destination, authorization.clone()))
        .unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let socket = streams.0.lock().unwrap().streams["queued"]
        .socket
        .clone()
        .unwrap();
    let held = socket.lock().unwrap();
    // All operations must recheck when they acquire the socket, including operations
    // that already obtained its Arc before the grant was removed.
    thread::scope(|scope| {
        let read = scope.spawn(|| streams.read("queued"));
        let write = scope.spawn(|| streams.write("queued", b"forbidden"));
        let end = scope.spawn(|| streams.end("queued"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Arc::strong_count(&socket) < 5 {
            assert!(
                Instant::now() < deadline,
                "operations did not reach the socket"
            );
            thread::yield_now();
        }
        authorization.0.cancel();
        drop(held);
        assert_eq!(
            read.join().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            write.join().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            end.join().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    });
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    streams.close("queued");
    runtime
        .block_on(streams.open(
            "queued".into(),
            &destination,
            Arc::new(Authorization::default()),
        ))
        .unwrap();
    let (mut replacement, _) = listener.accept().unwrap();
    replacement
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(streams.write("queued", b"new").unwrap(), 3);
    let mut bytes = [0; 3];
    replacement.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"new");
    streams.close_all();
}

#[test]
fn tcp_cancelled_open_releases_only_its_own_reservation() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let destination = crate::NetworkRequest::new(
            crate::NetworkProtocol::Socks5Tcp,
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
        )
        .unwrap();
        let streams = TcpStreams::default();
        let authorization = Arc::new(Authorization::default());
        let open = streams.open("pending".into(), &destination, authorization.clone());
        tokio::pin!(open);
        // Poll once without yielding to the reactor: connect is waiting for readiness.
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(open.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        streams.close("pending");
        let replacement = streams.open(
            "pending".into(),
            &destination,
            Arc::new(Authorization::default()),
        );
        tokio::pin!(replacement);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(replacement.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        authorization.0.cancel();
        assert_eq!(
            open.await.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        replacement.await.unwrap();
        assert_eq!(streams.write("pending", b"replacement").unwrap(), 11);
        streams.close_all();
    });
}

#[test]
fn dropping_pending_tcp_open_releases_capacity() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let destination = crate::NetworkRequest::new(
            crate::NetworkProtocol::Socks5Tcp,
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
        )
        .unwrap();
        let streams = TcpStreams::default();
        {
            let open = streams.open(
                "pending".into(),
                &destination,
                Arc::new(Authorization::default()),
            );
            tokio::pin!(open);
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(open.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
        }
        streams
            .open(
                "pending".into(),
                &destination,
                Arc::new(Authorization::default()),
            )
            .await
            .unwrap();
        assert_eq!(streams.write("pending", b"replacement").unwrap(), 11);
    });
}

#[test]
fn tcp_read_discards_bytes_when_revocation_races_with_the_syscall() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let destination = crate::NetworkRequest::new(
        crate::NetworkProtocol::Socks5Tcp,
        "127.0.0.1",
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let streams = TcpStreams::default();
    let authorization = Arc::new(Authorization::default());
    runtime
        .block_on(streams.open("read".into(), &destination, authorization.clone()))
        .unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    peer.write_all(b"must not be returned").unwrap();
    authorization.1.store(true, Ordering::SeqCst);
    assert_eq!(
        streams.read("read").unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
}
