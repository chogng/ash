#![cfg(target_os = "linux")]
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::ManagedNetworkAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxPolicy;
use mxc_sandbox::MxcSandbox;
use network_proxy::NetworkDecision;
use network_proxy::NetworkPolicyHandle;
use network_proxy::NetworkProxy;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[test]
#[ignore = "requires Linux user namespaces, Bubblewrap and ASH_NETWORK_PROBE"]
fn namespace_proxy_allows_authorized_traffic_and_blocks_direct_host_access() {
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = origin.local_addr().unwrap().port();
    origin.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let server = std::thread::spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            match origin.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut headers = Vec::new();
                    let mut byte = [0];
                    while headers.len() < 8192 && !headers.ends_with(b"\r\n\r\n") {
                        if stream.read_exact(&mut byte).is_err() {
                            break;
                        }
                        headers.push(byte[0]);
                    }
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\napproved");
                }
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    });
    let forbidden = TcpListener::bind("127.0.0.1:0").unwrap();
    forbidden.set_nonblocking(true).unwrap();
    let forbidden_port = forbidden.local_addr().unwrap().port();
    let udp = std::net::UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, forbidden_port)).unwrap();
    udp.set_nonblocking(true).unwrap();
    let policy = NetworkPolicyHandle::new(
        move |request: network_proxy::NetworkRequest, _| async move {
            if request.port() == target {
                NetworkDecision::Allow
            } else {
                NetworkDecision::Deny("blocked".into())
            }
        },
    );
    let cancellation = CancellationSource::new();
    let proxy = NetworkProxy::start_shared(policy, &cancellation.token()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let probe =
        std::env::var("ASH_NETWORK_PROBE").expect("build the network-proxy probe example first");
    let command = SandboxCommand::new(
        probe,
        [
            target.to_string(),
            forbidden_port.to_string(),
            forbidden_port.to_string(),
        ],
        dir.canonical_path(),
    )
    .with_network_proxy(ManagedNetworkAccess::new(
        proxy.http_port().try_into().unwrap(),
        proxy.socks_port().try_into().unwrap(),
    ));
    let sandbox = MxcSandbox::new(ash_install_context::InstallContext::current());
    let prepared = sandbox
        .prepare(
            &command,
            SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed),
            &dir,
        )
        .unwrap();
    let environment = network_proxy::ProxyEnvironment::new(
        proxy.http_port().try_into().unwrap(),
        proxy.socks_port().try_into().unwrap(),
    )
    .variables()
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect::<Vec<_>>();
    let mut child = prepared.spawn(&environment).unwrap();
    drop(child.take_stdin());
    let mut stdout = child.take_stdout().unwrap();
    let mut stderr = child.take_stderr().unwrap();
    let output = std::thread::spawn(move || {
        let mut data = String::new();
        stdout.read_to_string(&mut data).unwrap();
        data
    });
    let errors = std::thread::spawn(move || {
        let mut data = String::new();
        stderr.read_to_string(&mut data).unwrap();
        data
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "SDK sandbox did not complete"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = output.join().unwrap();
    let errors = errors.join().unwrap();
    stop.store(true, Ordering::Release);
    server.join().unwrap();
    assert_eq!(status.code(), Some(0), "{errors}");
    assert!(output.contains("network-probe-ready"));
    assert_eq!(
        forbidden.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        udp.recv(&mut [0; 64]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
