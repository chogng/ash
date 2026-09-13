use std::io::Write;

use ash_app_server_protocol::schema_hash;

use super::copy_output;
use super::diagnostic_error;
use super::validate_managed_response;
use crate::endpoint::EndpointPaths;
use crate::process::ProcessRecord;
use crate::process::ProcessRecordGuard;
use crate::wire::ControlResponse;
use crate::wire::ControlState;

#[test]
fn stdio_proxy_flushes_a_response_without_waiting_for_connection_close() {
    use std::io;
    use std::io::Read;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    struct PausedReader {
        first: bool,
        release: mpsc::Receiver<()>,
    }

    impl Read for PausedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if !self.first {
                self.first = true;
                let response = b"{\"id\":1}\n";
                buffer[..response.len()].copy_from_slice(response);
                return Ok(response.len());
            }
            self.release.recv().unwrap();
            Ok(0)
        }
    }

    struct FlushObserver {
        buffered: Vec<u8>,
        delivered: mpsc::Sender<Vec<u8>>,
    }

    impl Write for FlushObserver {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.buffered.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.delivered
                .send(std::mem::take(&mut self.buffered))
                .unwrap();
            Ok(())
        }
    }

    let (release, receiver) = mpsc::channel();
    let (delivered, output) = mpsc::channel();
    let worker = thread::spawn(move || {
        copy_output(
            &mut PausedReader {
                first: false,
                release: receiver,
            },
            &mut FlushObserver {
                buffered: Vec::new(),
                delivered,
            },
        )
    });
    let response = output.recv_timeout(Duration::from_secs(1));
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(response.unwrap(), b"{\"id\":1}\n");
}

#[test]
fn managed_control_response_must_match_the_private_process_record() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let record = ProcessRecord::current(&endpoint).unwrap();
    let _record = ProcessRecordGuard::publish(&endpoint.pid, &record).unwrap();
    let valid = ControlResponse::new(
        ControlState::Running,
        record.pid,
        record.instance_id.clone(),
        schema_hash(),
    );
    let mismatched = ControlResponse::new(
        ControlState::Running,
        record.pid,
        "replacement".into(),
        schema_hash(),
    );

    assert_eq!(
        validate_managed_response(&endpoint, &valid).unwrap(),
        record
    );
    assert_eq!(
        validate_managed_response(&endpoint, &mismatched).unwrap_err(),
        "App Server daemon endpoint does not match its managed process record"
    );
}

#[test]
fn lifecycle_errors_include_only_the_bounded_log_tail() {
    let profile = tempfile::tempdir().unwrap();
    let endpoint = EndpointPaths::prepare(profile.path()).unwrap();
    let mut log = endpoint.open_log().unwrap();
    log.write_all(&vec![b'x'; 8192]).unwrap();
    log.write_all(b"\nuseful tail\n").unwrap();
    log.flush().unwrap();

    let error = diagnostic_error(&endpoint, "startup failed");

    assert!(error.starts_with("startup failed\n\nManaged daemon log"));
    assert!(error.ends_with("useful tail"));
    assert!(error.len() < 5000);
}

#[cfg(unix)]
#[test]
fn failed_initialization_reaps_only_the_new_backend() {
    use crate::ConnectionOptions;
    use crate::GrantSource;
    use crate::LifecycleCommand;
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("failed-backend");
    std::fs::write(&executable, "#!/bin/sh\nexit 23\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let options = ConnectionOptions::new(root.path(), None, GrantSource::HostConfiguration, None);
    let error = super::run_lifecycle(LifecycleCommand::Start, options, &executable).unwrap_err();
    assert!(error.contains("exited before initialization"), "{error}");
    let endpoint = EndpointPaths::prepare(root.path()).unwrap();
    assert!(!endpoint.pid.exists());
    assert!(!endpoint.socket.exists());
}
