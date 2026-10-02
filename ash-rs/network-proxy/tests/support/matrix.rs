//! Private fixtures shared by the two platform acceptance tests.
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::UdpSocket;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub struct Matrix {
    pub v4: SocketAddr,
    pub v6: SocketAddr,
    pub dns: String,
    pub targets: String,
    pub requests: Arc<std::sync::Mutex<Vec<network_proxy::NetworkRequest>>>,
    stop: Arc<AtomicBool>,
    dns_hits: Arc<AtomicUsize>,
    threads: Vec<std::thread::JoinHandle<()>>,
    host_counter: Option<HostCounter>,
}

struct HostCounter {
    path: std::path::PathBuf,
    expected: AtomicUsize,
}

impl Matrix {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let hits = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        let mut origins = Vec::<SocketAddr>::new();
        let mut resolvers = Vec::new();
        for index in 0..3 {
            let address = match index {
                0 => "127.0.0.1:0".to_owned(),
                1 => "[::1]:0".to_owned(),
                _ => format!("[::1]:{}", origins[0].port()),
            };
            let origin = TcpListener::bind(&address).unwrap();
            origins.push(origin.local_addr().unwrap());
            origin.set_nonblocking(true).unwrap();
            let stopped = Arc::clone(&stop);
            threads.push(std::thread::spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    match origin.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_read_timeout(Some(Duration::from_millis(600))).unwrap();
                            let mut headers = Vec::new();
                            let mut byte = [0];
                            while headers.len() < 8192 && !headers.ends_with(b"\r\n\r\n") {
                                if stream.read_exact(&mut byte).is_err() { break; }
                                headers.push(byte[0]);
                            }
                            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\napproved");
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                        Err(error) => panic!("origin failed: {error}"),
                    }
                }
            }));
            if index == 2 {
                continue;
            }
            let tcp = TcpListener::bind(&address).unwrap();
            let endpoint = tcp.local_addr().unwrap();
            resolvers.push(endpoint);
            tcp.set_nonblocking(true).unwrap();
            let udp = UdpSocket::bind(endpoint).unwrap();
            udp.set_nonblocking(true).unwrap();
            let stopped = Arc::clone(&stop);
            let received = Arc::clone(&hits);
            threads.push(std::thread::spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    let mut query = [0; 2048];
                    if let Ok((length, peer)) = udp.recv_from(&mut query) {
                        received.fetch_add(1, Ordering::Relaxed);
                        query[2] |= 0x80;
                        let _ = udp.send_to(&query[..length], peer);
                    }
                    if let Ok((mut stream, _)) = tcp.accept() {
                        stream
                            .set_read_timeout(Some(Duration::from_millis(600)))
                            .unwrap();
                        let mut length = [0; 2];
                        if stream.read_exact(&mut length).is_ok() {
                            let mut query = vec![0; u16::from_be_bytes(length) as usize];
                            if stream.read_exact(&mut query).is_ok() && query.len() >= 12 {
                                received.fetch_add(1, Ordering::Relaxed);
                                query[2] |= 0x80;
                                let _ = stream.write_all(&length);
                                let _ = stream.write_all(&query);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }));
        }
        let v4 = origins[0];
        let v6 = origins[1];
        let mut dns = resolvers
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        // The host's real port-53 resolver complements the counted local wire fixtures.
        dns.push(
            std::env::var("ASH_DNS_SERVER")
                .expect("provide a reachable DNS socket address on port 53"),
        );
        if let Ok(endpoint) = std::env::var("ASH_WINDOWS_DNS_ENDPOINT") {
            dns.push(endpoint);
        }
        let mut targets = origins.iter().map(ToString::to_string).collect::<Vec<_>>();
        if let Ok(endpoint) = std::env::var("ASH_WINDOWS_NETWORK_ENDPOINT") {
            targets.push(endpoint);
        }
        Self {
            v4,
            v6,
            dns: dns.join(","),
            targets: targets.join(","),
            requests: Arc::default(),
            stop,
            dns_hits: hits,
            threads,
            host_counter: std::env::var_os("ASH_WINDOWS_NETWORK_COUNTER").map(|path| HostCounter {
                path: path.into(),
                expected: AtomicUsize::new(0),
            }),
        }
    }

    pub fn arguments(&self, mode: &str) -> Vec<String> {
        vec![
            mode.into(),
            self.v4.to_string(),
            self.v6.to_string(),
            self.dns.clone(),
            self.targets.clone(),
        ]
    }

    pub fn positive_control(&self, probe: &std::path::Path) {
        let output = std::process::Command::new(probe)
            .args(self.arguments("allowed"))
            .output()
            .unwrap();
        assert!(output.status.success(), "host positive control: {output:?}");
        println!("{}", String::from_utf8_lossy(&output.stdout));
        assert_eq!(self.dns_hits.load(Ordering::Acquire), 8);
        if let Some(counter) = &self.host_counter {
            counter.expected.store(
                std::fs::read_to_string(&counter.path)
                    .unwrap()
                    .parse()
                    .unwrap(),
                Ordering::Release,
            );
        }
    }

    pub fn policy(&self) -> network_proxy::NetworkPolicyHandle {
        let v4 = self.v4;
        let v6 = self.v6;
        let requests = Arc::clone(&self.requests);
        network_proxy::NetworkPolicyHandle::new(move |request: network_proxy::NetworkRequest, _| {
            let allowed = (request.port() == v4.port()
                && matches!(request.host(), "127.0.0.1" | "localhost"))
                || (request.port() == v6.port() && request.host() == "::1");
            requests.lock().unwrap().push(request);
            async move {
                if allowed {
                    network_proxy::NetworkDecision::Allow
                } else {
                    network_proxy::NetworkDecision::Deny("matrix denied".into())
                }
            }
        })
    }

    pub fn assert_no_dns_escape(&self) {
        assert_eq!(
            self.dns_hits.load(Ordering::Acquire),
            8,
            "sandbox sent a direct DNS transaction to the host"
        );
        if let Some(counter) = &self.host_counter {
            let current: usize = std::fs::read_to_string(&counter.path)
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(
                current,
                counter.expected.load(Ordering::Acquire),
                "traffic escaped to the Windows fixture"
            );
        }
    }

    pub fn assert_policy_observed(&self) {
        let requests = self.requests.lock().unwrap();
        for host in ["127.0.0.1", "::1", "localhost", "blocked.invalid"] {
            for protocol in [
                network_proxy::NetworkProtocol::Http,
                network_proxy::NetworkProtocol::HttpsConnect,
                network_proxy::NetworkProtocol::Socks5Tcp,
            ] {
                assert!(
                    requests
                        .iter()
                        .any(|r| r.host() == host && r.protocol() == protocol),
                    "missing policy decision {host}, {protocol:?}: {requests:?}"
                );
            }
        }
    }
}

impl Drop for Matrix {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for thread in self.threads.drain(..) {
            thread.join().unwrap();
        }
    }
}
