use super::*;
use crate::GrantSource;
use crate::wire::ConnectionPrelude;
use crate::wire::ControlPrelude;
use crate::wire::write_json_line;
use std::net::Shutdown;

#[test]
fn polling_reclaims_oversized_logs_without_restart_and_preserves_the_writer() {
    let profile = tempfile::tempdir().unwrap();
    let mut endpoint = ManagedEndpoint::bind(profile.path()).unwrap();
    let mut writer = endpoint.endpoint.open_log().unwrap();
    writer.set_len(2 * 1024 * 1024).unwrap();
    endpoint.last_log_maintenance = Instant::now() - Duration::from_secs(2);
    assert!(endpoint.poll_connection().unwrap().is_none());
    assert_eq!(writer.metadata().unwrap().len(), 0);
    writer.write_all(b"after maintenance\n").unwrap();
    assert_eq!(endpoint.endpoint.log_tail().unwrap(), "after maintenance");
    std::fs::remove_file(&endpoint.endpoint.log).unwrap();
}

#[test]
fn incomplete_prelude_leaves_business_and_stop_connections_available() {
    let profile = tempfile::tempdir().unwrap();
    let mut endpoint = ManagedEndpoint::bind(profile.path()).unwrap();
    let _silent = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
    let started = Instant::now();
    assert!(endpoint.poll_connection().unwrap().is_none());
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(endpoint.has_pending_connections());

    let options =
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None);
    let mut business = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
    let mut bytes = serde_json::to_vec(&ConnectionPrelude::from_options(&options)).unwrap();
    bytes.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n");
    business.write_all(&bytes).unwrap();
    business.shutdown(Shutdown::Write).unwrap();
    let mut accepted = endpoint
        .poll_connection()
        .unwrap()
        .expect("ready peer bypasses incomplete peer");
    assert_eq!(accepted.options, options);
    let mut first_rpc = String::new();
    accepted.reader.read_line(&mut first_rpc).unwrap();
    assert_eq!(
        first_rpc,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n"
    );

    let mut stop = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
    stop.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    write_json_line(&mut stop, &ControlPrelude::new(ControlCommand::Stop)).unwrap();
    assert!(endpoint.poll_connection().unwrap().is_none());
    assert!(endpoint.is_stopping());
    let mut response = String::new();
    BufReader::new(stop).read_line(&mut response).unwrap();
    let response: ControlResponse = serde_json::from_str(&response).unwrap();
    assert_eq!(response.state, ControlState::Stopping);
}

#[test]
fn partial_prelude_is_resumed_without_losing_buffered_rpc_bytes() {
    let profile = tempfile::tempdir().unwrap();
    let mut endpoint = ManagedEndpoint::bind(profile.path()).unwrap();
    let mut peer = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
    let options = ConnectionOptions::new(profile.path(), None, GrantSource::UserConfig, None);
    let mut prelude = serde_json::to_vec(&ConnectionPrelude::from_options(&options)).unwrap();
    prelude.extend_from_slice(b"\nfirst RPC\nsecond RPC\n");
    peer.write_all(&prelude[..8]).unwrap();
    assert!(endpoint.poll_connection().unwrap().is_none());
    peer.write_all(&prelude[8..]).unwrap();
    peer.shutdown(Shutdown::Write).unwrap();
    let mut accepted = endpoint.poll_connection().unwrap().unwrap();
    assert_eq!(accepted.options, options);
    let mut messages = String::new();
    accepted.reader.read_to_string(&mut messages).unwrap();
    assert_eq!(messages, "first RPC\nsecond RPC\n");
}

#[test]
fn pending_preludes_are_bounded_and_expired_without_waiting() {
    let profile = tempfile::tempdir().unwrap();
    let mut endpoint = ManagedEndpoint::bind(profile.path()).unwrap();
    let peers = (0..MAX_PENDING_PRELUDES)
        .map(|_| {
            let peer = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
            assert!(endpoint.poll_connection().unwrap().is_none());
            peer
        })
        .collect::<Vec<_>>();
    let mut rejected = UnixStream::connect(&endpoint.endpoint.socket).unwrap();
    rejected
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert!(endpoint.poll_connection().unwrap().is_none());
    assert_eq!(endpoint.pending.len(), MAX_PENDING_PRELUDES);
    assert_eq!(rejected.read(&mut [0]).unwrap(), 0);
    for pending in &mut endpoint.pending {
        pending.deadline = Instant::now();
    }
    assert!(endpoint.poll_connection().unwrap().is_none());
    assert!(endpoint.pending.is_empty());
    assert!(!endpoint.has_pending_connections());
    drop(peers);
}
