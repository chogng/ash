use super::*;

#[test]
fn relay_allocation_accepts_only_a_real_numeric_port() {
    for text in ["0\n", "65536\n", "Allocated port 123\n", "12\n34", "-1", ""] {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(text.as_bytes()).unwrap();
        assert!(read_allocation(file).is_err(), "{text:?}");
    }
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"43123\n").unwrap();
    assert_eq!(read_allocation(file).unwrap(), 43123);
}

#[test]
fn host_options_reject_option_injection_and_incomplete_assets() {
    assert!(Options::parse(vec!["--relay".into(), "-oProxyCommand=bad".into()]).is_err());
    assert!(
        Options::parse(vec![
            "--relay".into(),
            "relay".into(),
            "--relay".into(),
            "other".into()
        ])
        .is_err()
    );
    assert!(Options::parse(vec!["--unknown".into(), "value".into()]).is_err());
}

#[cfg(unix)]
#[test]
fn real_children_release_the_web_lease_and_ssh_master_after_stop() {
    use std::net::TcpListener;
    use std::net::TcpStream;
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let available = || {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    let web_port = available();
    let master_port = available();
    let backend = directory.path().join("backend");
    let ssh = directory.path().join("ssh");
    std::fs::write(&backend, format!(r#"#!/usr/bin/env python3
import socket,sys,json
listener=socket.socket(); listener.bind(('127.0.0.1',{web_port})); listener.listen()
print(json.dumps({{'endpoint':'http://127.0.0.1:{web_port}/','ticket':'a'*64,'pid':123}}),flush=True)
sys.stdin.buffer.read()
"#)).unwrap();
    std::fs::write(
        &ssh,
        format!(
            r#"#!/usr/bin/env python3
import socket,sys,time
if '-O' in sys.argv:
 if 'forward' in sys.argv:
  assert '127.0.0.1:0:127.0.0.1:{web_port}' in sys.argv
  print(43123,flush=True)
 sys.exit(0)
assert '-M' in sys.argv and 'ClearAllForwardings=yes' in sys.argv
listener=socket.socket(); listener.bind(('127.0.0.1',{master_port})); listener.listen()
while True: time.sleep(1)
"#
        ),
    )
    .unwrap();
    for path in [&backend, &ssh] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let options = Options {
        relay: SshHost::parse("relay").unwrap(),
        ssh,
        backend,
        assets: directory.path().into(),
    };
    let stopped = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stopped);
    let (sender, receiver) = mpsc::sync_channel(1);
    struct Published(mpsc::SyncSender<Vec<u8>>, Vec<u8>);
    impl Write for Published {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.1.extend(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.send(self.1.clone()).map_err(invalid)
        }
    }
    let worker =
        thread::spawn(move || host(&options, &worker_stop, &mut Published(sender, Vec::new())));
    let record = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(record.starts_with(b"__ASH_TUNNEL_STATUS__"));
    assert!(TcpStream::connect(("127.0.0.1", web_port)).is_ok());
    stopped.store(true, Ordering::Release);
    worker.join().unwrap().unwrap();
    assert!(TcpStream::connect(("127.0.0.1", web_port)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", master_port)).is_err());
}

#[cfg(unix)]
#[test]
fn cancellation_before_web_readiness_reaps_the_launcher() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let backend = directory.path().join("backend");
    std::fs::write(
        &backend,
        "#!/usr/bin/env python3\nimport sys\nsys.stdin.buffer.read()\n",
    )
    .unwrap();
    std::fs::set_permissions(&backend, std::fs::Permissions::from_mode(0o700)).unwrap();
    let options = Options {
        relay: SshHost::parse("relay").unwrap(),
        ssh: "ssh".into(),
        backend,
        assets: directory.path().into(),
    };
    let stopped = AtomicBool::new(true);
    let error = host(&options, &stopped, &mut Vec::new()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
}
