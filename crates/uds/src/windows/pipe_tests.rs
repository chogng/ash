use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::sync::Arc;
use std::sync::mpsc;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;
use std::time::Duration;
use std::time::Instant;

use super::Direction;
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
fn synchronous_io_can_wait_inside_futures_block_on() {
    futures::executor::block_on(async { assert_blocking_read_times_out() });
}

#[test]
fn synchronous_io_can_wait_inside_a_local_pool() {
    futures::executor::LocalPool::new().run_until(async { assert_blocking_read_times_out() });
}

#[test]
fn synchronous_io_can_nest_its_blocking_bridge() {
    futures_lite::future::block_on(async { assert_blocking_read_times_out() });
}

fn assert_blocking_read_times_out() {
    let (mut reader, _peer) = IpcStream::pair().unwrap();
    reader
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    // The peer stays open without sending bytes, forcing the synchronous wait path.
    assert_eq!(
        reader.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
}

struct ChannelWake {
    index: usize,
    sender: mpsc::Sender<usize>,
}

impl Wake for ChannelWake {
    fn wake(self: Arc<Self>) {
        let _ = self.sender.send(self.index);
    }
}

#[test]
fn shutdown_wakes_every_clone_waiting_on_the_same_pipe() {
    let (stream, _peer) = IpcStream::pair().unwrap();
    let readers = (0..4)
        .map(|_| stream.try_clone().unwrap())
        .collect::<Vec<_>>();
    let (sender, receiver) = mpsc::channel();
    let wakers = (0..readers.len())
        .map(|index| {
            Waker::from(Arc::new(ChannelWake {
                index,
                sender: sender.clone(),
            }))
        })
        .collect::<Vec<_>>();
    let mut waits = readers
        .iter()
        .map(|reader| Box::pin(reader.ready(Direction::Read)))
        .collect::<Vec<_>>();
    let _runtime = super::readiness::enter().unwrap();
    // Poll every future before shutdown, proving that all waiters registered their wakers.
    for (wait, waker) in waits.iter_mut().zip(&wakers) {
        assert!(
            wait.as_mut()
                .poll(&mut Context::from_waker(waker))
                .is_pending()
        );
    }
    stream.shutdown(Shutdown::Both).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut woken = vec![false; readers.len()];
    while !woken.iter().all(|woken| *woken) {
        let index = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        woken[index] = true;
    }
    for (wait, waker) in waits.iter_mut().zip(&wakers) {
        assert!(matches!(
            wait.as_mut().poll(&mut Context::from_waker(waker)),
            Poll::Ready(_)
        ));
    }
    for mut reader in &readers {
        assert_eq!(
            reader.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::NotConnected
        );
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
