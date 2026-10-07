use ash_secrets::SecretValue;
use livekit_api::MediaService;
use std::net::TcpListener;
use std::net::TcpStream;
use std::net::UdpSocket;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

pub struct Server {
    child: Child,
    _directory: tempfile::TempDir,
    pub service: MediaService,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    pub fn start() -> Self {
        let executable = std::env::var_os("ASH_TEST_LIVEKIT_SERVER")
            .expect("set ASH_TEST_LIVEKIT_SERVER to the verified LiveKit executable");
        let directory = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let udp = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let secret = "ash-test-livekit-secret-thirty-two-bytes";
        let config = directory.path().join("livekit.yaml");
        std::fs::write(&config, format!("port: {port}\nbind_addresses: [127.0.0.1]\nrtc:\n  udp_port: {udp}\n  tcp_port: 0\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ash-test: {secret}\nlogging:\n  level: error\n")).unwrap();
        let child = Command::new(executable)
            .arg("--config")
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let service = MediaService::new(
            &format!("ws://127.0.0.1:{port}"),
            &format!("http://127.0.0.1:{port}"),
            "ash-test".into(),
            SecretValue::new(secret.as_bytes().to_vec()),
        )
        .unwrap();
        let mut server = Self {
            child,
            _directory: directory,
            service,
        };
        let start = Instant::now();
        loop {
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "LiveKit exited before listening"
            );
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "LiveKit startup timed out"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        server
    }
}
