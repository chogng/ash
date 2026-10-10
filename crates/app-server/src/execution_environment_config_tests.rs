use super::ConnectionOutcome;
use super::ConnectionTransport;
use super::EndpointConfig;
use super::load_environments_observed;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;
use std::time::Instant;

#[test]
fn execution_configuration_accepts_one_complete_transport() {
    for value in [
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project","runtime":"/package/bin/ash-remote-server"}),
    ] {
        serde_json::from_value::<EndpointConfig>(value).unwrap();
    }
}

#[test]
fn execution_configuration_rejects_partial_mixed_and_unknown_inputs() {
    for value in [
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project","runtime":"/runtime","token_file":"worker.token"}),
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token","host":"build","root":"/remote/project","runtime":"/runtime"}),
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token","extra":true}),
    ] {
        assert!(serde_json::from_value::<EndpointConfig>(value).is_err());
    }
}

#[test]
fn initial_connection_observation_includes_handshake_identity_and_failures() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("environments.json");
    let token = "a1".repeat(32);
    std::fs::write(directory.path().join("worker.token"), &token).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!([{
        "environment":"worker", "address":listener.local_addr().unwrap(), "token_file":"worker.token"
    }])).unwrap()).unwrap();
    let (handshake_tx, handshake_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        for identity in ["wrong-worker", "worker"] {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = String::new();
            BufReader::new(&mut socket).read_line(&mut request).unwrap();
            let request: exec_server_protocol::Message = serde_json::from_str(&request).unwrap();
            assert_eq!(request.token, token);
            assert!(matches!(
                request.request,
                exec_server_protocol::Request::EnvironmentInfo
            ));
            handshake_tx.send(Instant::now()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let response = exec_server_protocol::Response::Environment(
                exec_server_protocol::EnvironmentInfo {
                    environment_id: identity.into(),
                    incarnation: "b2".repeat(32),
                    root: "/workspace".into(),
                    access: exec_server_protocol::FileAccess::ReadWrite,
                    network: exec_server_protocol::NetworkAccess::Denied,
                },
            );
            serde_json::to_writer(&mut socket, &response).unwrap();
            socket.write_all(b"\n").unwrap();
        }
    });
    let (observation_tx, observation_rx) = std::sync::mpsc::channel();
    let loader = std::thread::spawn(move || {
        let mut measurements = Vec::new();
        for success in [false, true] {
            let result = load_environments_observed(&path, &mut |measurement| {
                observation_tx.send(measurement).unwrap();
                measurements.push(measurement);
            });
            assert_eq!(result.is_ok(), success);
            if let Ok(environments) = result {
                assert_eq!(environments[0].info().environment_id, "worker");
            }
        }
        assert_eq!(measurements.len(), 2);
        assert_eq!(measurements[0].outcome, ConnectionOutcome::Failure);
        assert_eq!(measurements[1].outcome, ConnectionOutcome::Success);
    });
    for expected in [ConnectionOutcome::Failure, ConnectionOutcome::Success] {
        let handshake = handshake_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            observation_rx.try_recv().is_err(),
            "handshake is not yet installed"
        );
        let held = handshake.elapsed();
        release_tx.send(()).unwrap();
        let measurement = observation_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(measurement.transport, ConnectionTransport::Tcp);
        assert_eq!(measurement.outcome, expected);
        assert!(measurement.elapsed >= held);
    }
    loader.join().unwrap();
    server.join().unwrap();
    assert!(observation_rx.try_recv().is_err());
}

#[test]
fn initial_connection_observation_reports_ssh_startup_failure_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("environments.json");
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!([{
        "environment":"worker", "host":"build", "root":"/workspace", "runtime":"/package/ash-remote-server",
        "ssh_executable": directory.path().join("missing-ssh")
    }])).unwrap()).unwrap();
    let mut measurements = Vec::new();
    assert!(
        load_environments_observed(&path, &mut |measurement| measurements.push(measurement))
            .is_err()
    );
    assert_eq!(measurements.len(), 1);
    assert_eq!(measurements[0].transport, ConnectionTransport::Ssh);
    assert_eq!(measurements[0].outcome, ConnectionOutcome::Failure);
}
