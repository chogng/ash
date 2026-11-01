use super::TcpStreams;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
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
        .block_on(streams.open("test".into(), &destination))
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
            .block_on(streams.open("late".into(), &destination))
            .is_err()
    );
    echo.join().unwrap();
}
