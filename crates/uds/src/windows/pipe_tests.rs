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

#[test]
fn synchronous_io_can_wait_inside_an_existing_tokio_runtime() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (mut client, mut server) = IpcStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = [0; 4];
            server.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ping");
            server.write_all(b"pong").unwrap();
        });
        client.write_all(b"ping").unwrap();
        let mut reply = [0; 4];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"pong");
        worker.join().unwrap();
    });
}

#[test]
fn shutdown_wakes_every_clone_waiting_on_the_same_pipe() {
    let (stream, _peer) = IpcStream::pair().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
    let (finished, results) = std::sync::mpsc::channel();
    let workers = (0..4)
        .map(|_| {
            let mut reader = stream.try_clone().unwrap();
            let barrier = barrier.clone();
            let finished = finished.clone();
            std::thread::spawn(move || {
                barrier.wait();
                finished.send(reader.read(&mut [0])).unwrap();
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    stream.shutdown(Shutdown::Both).unwrap();
    for _ in 0..4 {
        assert!(
            results
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .is_err()
        );
    }
    for worker in workers {
        worker.join().unwrap();
    }
}

#[test]
fn readiness_waits_remain_usable_after_a_timeout_and_listener_handoff() {
    let temporary = tempfile::tempdir().unwrap();
    let listener = IpcListener::bind(temporary.path().join("ready.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    // Dropping a timed-out connect future must leave its pending accept usable.
    crate::wait_for_ipc_activity(Some(&listener), &[], &[], Duration::from_millis(10)).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let mut client = IpcStream::connect(temporary.path().join("ready.sock")).unwrap();
    crate::wait_for_ipc_activity(Some(&listener), &[], &[], Duration::from_secs(1)).unwrap();
    let (mut server, ()) = listener.accept().unwrap();
    server.set_nonblocking(true).unwrap();
    assert_eq!(
        server.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    crate::wait_for_ipc_activity(None, &[&server], &[], Duration::from_millis(10)).unwrap();
    client.write_all(b"a").unwrap();
    crate::wait_for_ipc_activity(None, &[&server], &[], Duration::from_secs(1)).unwrap();
    assert_eq!(server.read(&mut [0]).unwrap(), 1);
    server.shutdown(Shutdown::Both).unwrap();
    crate::wait_for_ipc_activity(None, &[&server], &[], Duration::from_secs(1)).unwrap();
}
