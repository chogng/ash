#[test]
#[cfg(any(unix, windows))]
fn invalid_profile_config_is_rejected_before_daemon_socket_is_bound() {
    let profile = tempfile::tempdir().unwrap();
    std::fs::write(
        profile.path().join("config.toml"),
        "schemaVersion = 1\nunknownField = true\n",
    )
    .unwrap();
    let endpoint = ash_app_server_daemon::daemon_endpoint_path(profile.path()).unwrap();

    let error = super::run(profile.path().to_path_buf(), None).unwrap_err();

    assert!(error.contains("unknown field `unknownField`"));
    assert!(!endpoint.exists());
}

use std::io;

use super::is_peer_disconnect;

#[test]
fn peer_disconnects_are_normal_transport_shutdowns() {
    for kind in [
        io::ErrorKind::BrokenPipe,
        io::ErrorKind::ConnectionAborted,
        io::ErrorKind::ConnectionReset,
    ] {
        assert!(is_peer_disconnect(&io::Error::from(kind)));
    }
    assert!(!is_peer_disconnect(&io::Error::from(
        io::ErrorKind::PermissionDenied
    )));
}
