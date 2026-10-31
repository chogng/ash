use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::time::Duration;

use super::IpcListener;
use super::IpcStream;

#[test]
fn concurrent_clients_wait_for_accept_capacity_without_reporting_a_missing_daemon() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("backlog.sock");
    let listener = IpcListener::bind(&path).unwrap();
    let _clients = (0..4)
        .map(|_| IpcStream::connect(&path).unwrap())
        .collect::<Vec<_>>();
    let (started, waiting) = std::sync::mpsc::channel();
    let (connected, completion) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        connected.send(IpcStream::connect(path)).unwrap();
    });
    waiting.recv().unwrap();
    assert!(completion.recv_timeout(Duration::from_millis(20)).is_err());
    let _accepted = listener.accept().unwrap();
    let _fifth = completion
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
}

#[test]
fn write_shutdown_preserves_queued_bytes_and_the_reverse_direction() {
    let (mut client, mut server) = IpcStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    client.write_all(b"request").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(
        client.write(b"after EOF").unwrap_err().kind(),
        std::io::ErrorKind::BrokenPipe
    );
    let mut request = Vec::new();
    server.read_to_end(&mut request).unwrap();
    assert_eq!(request, b"request");
    assert_eq!(server.read(&mut [0]).unwrap(), 0);
    server.write_all(b"response after input EOF").unwrap();
    server.shutdown(Shutdown::Write).unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert_eq!(response, b"response after input EOF");
}
