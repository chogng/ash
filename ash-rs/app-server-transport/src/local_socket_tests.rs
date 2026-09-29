use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_uds::UnixListener;
use ash_uds::UnixStream;

use crate::LocalConnections;
use crate::LocalSocketAccept;
use crate::PollingLocalListener;

#[test]
fn input_eof_wakes_a_writer_when_the_peer_retains_its_read_half() -> io::Result<()> {
    let (mut server, peer) = UnixStream::pair()?;
    server.set_nonblocking(true)?;
    let payload = [0u8; 4096];
    loop {
        match server.write(&payload) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(error),
        }
    }
    let (reader, mut server) = crate::LocalStream::pair(server)?;
    let mut reader = std::io::BufReader::new(reader);
    let (ended, completion) = std::sync::mpsc::channel();
    let writer = thread::spawn(move || {
        ended.send(server.write_all(b"pending response")).unwrap();
    });
    peer.shutdown(std::net::Shutdown::Write)?;
    assert!(std::io::BufRead::fill_buf(&mut reader)?.is_empty());
    let error = completion
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap_err();
    assert!(matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::ConnectionReset
    ));
    writer.join().unwrap();
    Ok(())
}

#[test]
fn local_endpoint_rejects_other_users_and_elevation_contexts() {
    for peer in [
        ash_uds::PeerIdentity {
            same_user: false,
            same_elevation: true,
        },
        ash_uds::PeerIdentity {
            same_user: true,
            same_elevation: false,
        },
        ash_uds::PeerIdentity {
            same_user: false,
            same_elevation: false,
        },
    ] {
        assert_eq!(
            crate::local_socket::validate_local_identity(peer)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}

#[test]
fn polling_listener_returns_blocking_connections() -> io::Result<()> {
    let socket_directory = tempfile::tempdir()?;
    let socket_path = socket_directory.path().join("polling-listener.sock");
    let listener = PollingLocalListener::new(UnixListener::bind(&socket_path)?)?;
    assert!(matches!(
        listener.poll_accept()?,
        LocalSocketAccept::Pending
    ));

    let mut client = UnixStream::connect(&socket_path)?;
    let mut server = wait_for_connection(&listener)?;
    let sender = thread::spawn(move || -> io::Result<()> {
        thread::sleep(Duration::from_millis(50));
        client.write_all(b"ping")
    });

    let mut request = [0; 4];
    server.read_exact(&mut request)?;
    assert_eq!(&request, b"ping");
    sender.join().expect("socket sender thread panicked")?;
    Ok(())
}

#[test]
fn connection_guard_tracks_and_removes_connection() -> io::Result<()> {
    let (stream, _peer) = UnixStream::pair()?;
    let connections = Arc::new(LocalConnections::new());
    let guard = connections.register(stream.try_clone()?)?;
    assert_eq!(connections.len(), 1);

    drop(guard);
    assert!(connections.is_empty());
    Ok(())
}

fn wait_for_connection(listener: &PollingLocalListener) -> io::Result<UnixStream> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.poll_accept()? {
            LocalSocketAccept::Accepted(stream) => return Ok(stream),
            LocalSocketAccept::Pending if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            LocalSocketAccept::Pending => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "listener did not accept a connection",
                ));
            }
            LocalSocketAccept::Rejected(error) => return Err(error),
        }
    }
}
