use super::*;
use ash_async_utils::CancellationSource;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn allow() -> NetworkPolicyHandle {
    NetworkPolicyHandle::new(
        |_: NetworkRequest, _: ash_async_utils::CancellationToken| async { NetworkDecision::Allow },
    )
}

fn client(port: u16) -> TcpStream {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
}

fn read_headers(stream: &mut TcpStream) -> String {
    let mut headers = Vec::new();
    let mut byte = [0];
    while !headers.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        headers.push(byte[0]);
        assert!(headers.len() < 32 * 1024);
    }
    String::from_utf8(headers).unwrap()
}

#[test]
fn http_forwards_the_observed_target_and_strips_proxy_credentials() {
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = origin.local_addr().unwrap().port();
    let upstream = thread::spawn(move || {
        let (mut stream, _) = origin.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let headers = read_headers(&mut stream).to_ascii_lowercase();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
        headers
    });
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&requests);
    let proxy = NetworkProxy::start(
        NetworkPolicyHandle::new(move |request, _| {
            observed.lock().unwrap().push(request);
            async { NetworkDecision::Allow }
        }),
        &CancellationSource::new().token(),
    )
    .unwrap();
    let mut stream = client(proxy.http_port());
    write!(stream, "GET http://127.0.0.1:{port}/resource?x=1 HTTP/1.1\r\nHost: forged.example\r\nProxy-Authorization: secret\r\nConnection: close, x-private\r\nX-Private: secret\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.ends_with("ok"));
    let headers = upstream.join().unwrap();
    assert!(headers.starts_with("get /resource?x=1 http/1.1"));
    assert!(headers.contains(&format!("host: 127.0.0.1:{port}")));
    assert!(!headers.contains("secret"));
    assert_eq!(
        *requests.lock().unwrap(),
        vec![
            NetworkRequest::new(NetworkProtocol::Http, "127.0.0.1", port)
                .unwrap()
                .with_method("GET")
        ]
    );
}

#[test]
fn explicit_denial_never_opens_an_upstream_connection() {
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    origin.set_nonblocking(true).unwrap();
    let port = origin.local_addr().unwrap().port();
    let proxy = NetworkProxy::start(
        NetworkPolicyHandle::new(|_, _| async {
            NetworkDecision::Deny("denied by host rule".into())
        }),
        &CancellationSource::new().token(),
    )
    .unwrap();
    for method in ["GET", "POST"] {
        let mut stream = client(proxy.http_port());
        write!(stream, "{method} http://127.0.0.1:{port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").unwrap();
        assert!(read_headers(&mut stream).starts_with("HTTP/1.1 403"));
    }
    assert_eq!(
        origin.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let mut stream = client(proxy.http_port());
    stream.write_all(b"GET http://not-resolvable.invalid/ HTTP/1.1\r\nHost: not-resolvable.invalid\r\nConnection: close\r\n\r\n").unwrap();
    assert!(
        read_headers(&mut stream).starts_with("HTTP/1.1 403"),
        "policy must run before DNS"
    );
}

#[test]
fn connect_tunnels_bytes_after_authorization_and_closes_on_drop() {
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = origin.local_addr().unwrap().port();
    let (closed_tx, closed_rx) = mpsc::channel();
    let upstream = thread::spawn(move || {
        let (mut stream, _) = origin.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ping");
        stream.write_all(b"pong").unwrap();
        closed_tx.send(stream.read(&mut bytes).unwrap()).unwrap();
    });
    let proxy = NetworkProxy::start(allow(), &CancellationSource::new().token()).unwrap();
    let proxy_port = proxy.http_port();
    let mut stream = client(proxy_port);
    write!(
        stream,
        "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    assert!(read_headers(&mut stream).starts_with("HTTP/1.1 200"));
    stream.write_all(b"ping").unwrap();
    let mut bytes = [0; 4];
    stream.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"pong");
    drop(proxy);
    assert_eq!(closed_rx.recv_timeout(Duration::from_secs(3)).unwrap(), 0);
    assert!(TcpStream::connect(("127.0.0.1", proxy_port)).is_err());
    upstream.join().unwrap();
}

#[test]
fn socks_tcp_uses_the_same_policy_and_rejects_udp() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&requests);
    let proxy = NetworkProxy::start(
        NetworkPolicyHandle::new(move |request, _| {
            observed.lock().unwrap().push(request);
            async { NetworkDecision::Deny("forbidden".into()) }
        }),
        &CancellationSource::new().token(),
    )
    .unwrap();
    for (command, expected) in [(1, 2), (3, 7)] {
        let mut stream = client(proxy.socks_port());
        stream.write_all(&[5, 1, 0]).unwrap();
        let mut reply = [0; 2];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(reply, [5, 0]);
        stream
            .write_all(&[5, command, 0, 1, 127, 0, 0, 1, 1, 187])
            .unwrap();
        let mut reply = [0; 10];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(reply[1], expected);
    }
    assert_eq!(
        *requests.lock().unwrap(),
        vec![NetworkRequest::new(NetworkProtocol::Socks5Tcp, "127.0.0.1", 443).unwrap()]
    );
}

#[test]
fn shared_listener_serves_http_connect_and_socks_with_the_same_authority() {
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = origin.local_addr().unwrap().port();
    let upstream = thread::spawn(move || {
        for _ in 0..3 {
            let (mut stream, _) = origin.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            read_headers(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        }
    });
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&requests);
    let proxy = NetworkProxy::start_shared(
        NetworkPolicyHandle::new(move |request, _| {
            observed.lock().unwrap().push(request);
            async { NetworkDecision::Allow }
        }),
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert_eq!(proxy.http_port(), proxy.socks_port());
    for protocol in [
        NetworkProtocol::Http,
        NetworkProtocol::HttpsConnect,
        NetworkProtocol::Socks5Tcp,
    ] {
        let mut stream = client(proxy.http_port());
        match protocol {
            NetworkProtocol::Http => {
                write!(stream, "GET http://127.0.0.1:{port}/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            }
            NetworkProtocol::HttpsConnect => {
                write!(
                    stream,
                    "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: localhost\r\n\r\n"
                )
                .unwrap();
                assert!(read_headers(&mut stream).starts_with("HTTP/1.1 200"));
            }
            NetworkProtocol::Socks5Tcp => {
                stream.write_all(&[5, 1, 0]).unwrap();
                let mut greeting = [0; 2];
                stream.read_exact(&mut greeting).unwrap();
                assert_eq!(greeting, [5, 0]);
                let [high, low] = port.to_be_bytes();
                stream
                    .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, high, low])
                    .unwrap();
                let mut reply = [0; 10];
                stream.read_exact(&mut reply).unwrap();
                assert_eq!(reply[1], 0);
            }
        }
        if protocol != NetworkProtocol::Http {
            stream
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
        }
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("ok"));
    }
    upstream.join().unwrap();
    assert_eq!(
        *requests.lock().unwrap(),
        vec![
            NetworkRequest::new(NetworkProtocol::Http, "127.0.0.1", port)
                .unwrap()
                .with_method("GET"),
            NetworkRequest::new(NetworkProtocol::HttpsConnect, "127.0.0.1", port).unwrap(),
            NetworkRequest::new(NetworkProtocol::Socks5Tcp, "127.0.0.1", port).unwrap(),
        ]
    );
}

#[test]
fn dropping_shared_listener_closes_incomplete_protocol_handshakes() {
    let proxy = NetworkProxy::start_shared(allow(), &CancellationSource::new().token()).unwrap();
    let port = proxy.http_port();
    let mut stream = client(port);
    drop(proxy);
    let result = stream.read(&mut [0]);
    match result {
        Ok(count) => assert_eq!(count, 0),
        Err(error) => assert!(matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        )),
    }
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn cancelling_an_execution_cancels_pending_authorization() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let source = CancellationSource::new();
    let policy =
        NetworkPolicyHandle::new(move |_, cancellation: ash_async_utils::CancellationToken| {
            entered_tx.send(cancellation.clone()).unwrap();
            async move {
                cancellation.cancelled().await;
                NetworkDecision::Deny("cancelled".into())
            }
        });
    let proxy = NetworkProxy::start(policy, &source.token()).unwrap();
    let mut stream = client(proxy.http_port());
    stream
        .write_all(b"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n")
        .unwrap();
    let request_cancellation = entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    source.cancel();
    // Cancellation may drop the decision future before it can be polled again; its token must
    // still be cancelled and the listener/runtime must close synchronously on guard drop.
    drop(proxy);
    assert!(request_cancellation.is_cancelled());
    let mut byte = [0];
    match stream.read(&mut byte) {
        Ok(count) => assert_eq!(count, 0),
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
    }
}

#[test]
fn targets_normalize_dns_and_ip_authorities() {
    assert_eq!(
        NetworkRequest::new(NetworkProtocol::Http, "EXAMPLE.COM.", 80)
            .unwrap()
            .host(),
        "example.com"
    );
    assert_eq!(
        NetworkRequest::new(NetworkProtocol::HttpsConnect, "[::1]", 443)
            .unwrap()
            .authority(),
        "[::1]:443"
    );
    for host in ["", "user@host", "host/path", "bad host"] {
        assert!(NetworkRequest::new(NetworkProtocol::Http, host, 80).is_err());
    }
    assert!(NetworkRequest::new(NetworkProtocol::Http, "localhost", 0).is_err());
}
