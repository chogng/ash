#![cfg(unix)]

use std::io::Read;
use std::io::Write;
use std::time::Duration;
use std::time::Instant;

use ash_uds::UnixStream;

use super::DeadlineStream;

#[test]
fn unix_deadline_does_not_install_socket_timeouts() {
    let (stream, _peer) = UnixStream::pair().unwrap();
    let stream = DeadlineStream::new(stream, Instant::now() + Duration::from_secs(1)).unwrap();

    assert_eq!(stream.stream.read_timeout().unwrap(), None);
    assert_eq!(stream.stream.write_timeout().unwrap(), None);
}

#[test]
fn read_reports_when_the_absolute_deadline_elapses() {
    let (stream, _peer) = UnixStream::pair().unwrap();
    let mut stream =
        DeadlineStream::new(stream, Instant::now() + Duration::from_millis(20)).unwrap();

    let error = stream.read(&mut [0]).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
}

#[test]
fn ready_stream_exchanges_bytes_before_its_deadline() {
    let (client, server) = UnixStream::pair().unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut client = DeadlineStream::new(client, deadline).unwrap();
    let mut server = DeadlineStream::new(server, deadline).unwrap();

    client.write_all(b"ping").unwrap();
    let mut received = [0; 4];
    server.read_exact(&mut received).unwrap();

    assert_eq!(&received, b"ping");
}
