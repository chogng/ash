//! Platform acceptance probe. Built explicitly by the Linux/Windows integration scenarios.
use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments == ["noop"] {
        return;
    }
    if arguments.first().is_some_and(|value| value == "--child") {
        assert!(
            connect(arguments[1].parse().unwrap()).is_err(),
            "descendant escaped network restrictions"
        );
        return;
    }
    assert!(arguments.len() >= 4);
    #[cfg(target_os = "linux")]
    for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
        if let Ok(target) = std::fs::read_link(entry.unwrap().path()) {
            assert!(
                !target.to_string_lossy().starts_with("socket:"),
                "bootstrap socket reached the command"
            );
        }
    }
    let target: u16 = arguments[0].parse().unwrap();
    let forbidden: u16 = arguments[1].parse().unwrap();
    let foreign: u16 = arguments[2].parse().unwrap();
    let udp_target: u16 = arguments[3].parse().unwrap();
    let endpoint = |name: &str, scheme: &str| -> SocketAddr {
        let value = std::env::var(name).unwrap();
        value.strip_prefix(scheme).unwrap().parse().unwrap()
    };
    let proxy = endpoint("HTTP_PROXY", "http://");
    let socks = endpoint("ALL_PROXY", "socks5h://");
    assert_eq!(std::env::var("NO_PROXY").unwrap(), "");
    let mut http = connect_address(proxy).unwrap();
    write!(http, "GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\nConnection: close\r\n\r\n").unwrap();
    assert_response(http, "200", "approved");
    let mut denied = connect_address(proxy).unwrap();
    write!(denied, "GET http://127.0.0.1:{forbidden}/ HTTP/1.1\r\nHost: 127.0.0.1:{forbidden}\r\nConnection: close\r\n\r\n").unwrap();
    assert_response(denied, "403", "");
    let mut stream = connect_address(socks).unwrap();
    stream.write_all(&[5, 1, 0]).unwrap();
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting).unwrap();
    assert_eq!(greeting, [5, 0]);
    let [high, low] = target.to_be_bytes();
    stream
        .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, high, low])
        .unwrap();
    let mut reply = [0; 10];
    stream.read_exact(&mut reply).unwrap();
    assert_eq!(reply[1], 0);
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    assert_response(stream, "200", "approved");
    for port in [target, forbidden, foreign] {
        assert!(
            connect(port).is_err(),
            "direct/foreign connection escaped the sandbox: {port}"
        );
    }
    if proxy.ip() != std::net::IpAddr::V4(Ipv4Addr::LOCALHOST) {
        for port in [target, forbidden, foreign] {
            assert!(
                connect_address(SocketAddr::new(proxy.ip(), port)).is_err(),
                "direct host-gateway traffic escaped the proxy endpoint"
            );
        }
    }
    if let Ok(udp) = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)) {
        let _ = udp.send_to(b"must-not-escape", (Ipv4Addr::LOCALHOST, udp_target));
    }
    #[cfg(windows)]
    {
        assert!(
            std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).is_err(),
            "unapproved listener escaped the sandbox"
        );
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--child")
            .arg(forbidden.to_string())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "managed descendant could not preserve its execution boundary"
        );
    }
    println!("network-probe-ready");
    std::io::stdout().flush().unwrap();
    if arguments.get(4).is_some_and(|value| value == "hold") {
        let _ = std::io::stdin().read(&mut [0]);
    }
}

fn connect(port: u16) -> std::io::Result<TcpStream> {
    connect_address(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
}

fn connect_address(address: SocketAddr) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    Ok(stream)
}

fn assert_response(mut stream: TcpStream, code: &str, body: &str) {
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with(&format!("HTTP/1.1 {code}")),
        "expected HTTP {code}, received {response:?}"
    );
    assert!(response.ends_with(body), "{response}");
}
