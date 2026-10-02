//! Wire-level acceptance: every denied destination is checked by the host first.
use std::io::Read;
use std::io::Write;
use std::net::IpAddr;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::net::UdpSocket;
use std::time::Duration;

#[derive(Clone, Copy)]
enum Expected {
    Allowed,
    Denied,
}

#[derive(Clone, Copy, Debug)]
enum DnsTransport {
    Tcp,
    Udp,
}

fn connect(address: SocketAddr) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&address, Duration::from_millis(600))?;
    stream.set_read_timeout(Some(Duration::from_millis(600)))?;
    stream.set_write_timeout(Some(Duration::from_millis(600)))?;
    Ok(stream)
}

fn http(mut stream: TcpStream, authority: &str) -> String {
    write!(
        stream,
        "GET http://{authority}/ HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn socks(endpoint: SocketAddr, host: &str, port: u16, expected: Expected) {
    let mut stream = connect(endpoint).unwrap();
    stream.write_all(&[5, 1, 0]).unwrap();
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting).unwrap();
    assert_eq!(greeting, [5, 0]);
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(1);
            request.extend(address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(4);
            request.extend(address.octets());
        }
        Err(_) => {
            request.extend([3, u8::try_from(host.len()).unwrap()]);
            request.extend(host.bytes());
        }
    }
    request.extend(port.to_be_bytes());
    stream.write_all(&request).unwrap();
    let mut reply = [0; 10];
    stream.read_exact(&mut reply).unwrap();
    let allowed = matches!(expected, Expected::Allowed);
    assert_eq!(reply[1], if allowed { 0 } else { 2 }, "{host}:{port}");
    if allowed {
        assert!(http(stream, "localhost").ends_with("approved"));
    }
}

fn tunnel(endpoint: SocketAddr, authority: &str, expected: Expected) {
    let mut stream = connect(endpoint).unwrap();
    write!(
        stream,
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n"
    )
    .unwrap();
    let mut header = Vec::new();
    let mut byte = [0];
    while !header.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
        assert!(header.len() < 8192);
    }
    let allowed = matches!(expected, Expected::Allowed);
    let code = if allowed { "200" } else { "403" };
    assert!(
        String::from_utf8(header)
            .unwrap()
            .starts_with(&format!("HTTP/1.1 {code}")),
        "CONNECT {authority}"
    );
    if allowed {
        assert!(http(stream, "localhost").ends_with("approved"));
    }
}

fn dns(address: SocketAddr, transport: DnsTransport, record: u16) -> std::io::Result<Vec<u8>> {
    // An actual A/AAAA DNS transaction, independent of OS resolver caches.
    let mut query = vec![0x41, 0x53, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in ["example", "com"] {
        query.push(u8::try_from(label.len()).unwrap());
        query.extend(label.bytes());
    }
    query.push(0);
    query.extend(record.to_be_bytes());
    query.extend([0, 1]);
    if matches!(transport, DnsTransport::Tcp) {
        let mut stream = connect(address)?;
        stream.write_all(&u16::try_from(query.len()).unwrap().to_be_bytes())?;
        stream.write_all(&query)?;
        let mut length = [0; 2];
        stream.read_exact(&mut length)?;
        let mut reply = vec![0; u16::from_be_bytes(length) as usize];
        stream.read_exact(&mut reply)?;
        Ok(reply)
    } else {
        let local = if address.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = UdpSocket::bind(local)?;
        socket.set_read_timeout(Some(Duration::from_millis(600)))?;
        socket.connect(address)?;
        socket.send(&query)?;
        let mut reply = [0; 2048];
        let length = socket.recv(&mut reply)?;
        Ok(reply[..length].to_vec())
    }
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let mode = &arguments[0];
    let v4: SocketAddr = arguments[1].parse().unwrap();
    let v6: SocketAddr = arguments[2].parse().unwrap();
    let dns_addresses = arguments[3]
        .split(',')
        .map(|s| s.parse::<SocketAddr>().unwrap());
    let targets = arguments[4]
        .split(',')
        .map(|s| s.parse::<SocketAddr>().unwrap());
    if mode == "managed" {
        let endpoint = |name: &str, prefix: &str| {
            std::env::var(name)
                .unwrap()
                .strip_prefix(prefix)
                .unwrap()
                .parse::<SocketAddr>()
                .unwrap()
        };
        let proxy = endpoint("HTTP_PROXY", "http://");
        let socks_proxy = endpoint("ALL_PROXY", "socks5h://");
        for authority in [
            v4.to_string(),
            v6.to_string(),
            format!("localhost:{}", v4.port()),
        ] {
            assert!(
                http(connect(proxy).unwrap(), &authority).ends_with("approved"),
                "{authority}"
            );
            tunnel(proxy, &authority, Expected::Allowed);
        }
        for (host, port) in [
            ("127.0.0.1", v4.port()),
            ("::1", v6.port()),
            ("localhost", v4.port()),
        ] {
            socks(socks_proxy, host, port, Expected::Allowed);
        }
        let authority = format!("blocked.invalid:{}", v4.port());
        assert!(http(connect(proxy).unwrap(), &authority).starts_with("HTTP/1.1 403"));
        tunnel(proxy, &authority, Expected::Denied);
        socks(socks_proxy, "blocked.invalid", v4.port(), Expected::Denied);
        // Also deny a numeric IPv6 destination with the same reachable origin.
        let authority = format!("[::1]:{}", v4.port());
        assert!(http(connect(proxy).unwrap(), &authority).starts_with("HTTP/1.1 403"));
        tunnel(proxy, &authority, Expected::Denied);
        socks(socks_proxy, "::1", v4.port(), Expected::Denied);
    }
    for address in targets {
        if mode == "allowed" {
            assert!(
                http(connect(address).unwrap(), &address.to_string()).ends_with("approved"),
                "host positive control {address}"
            );
        } else {
            assert!(connect(address).is_err(), "direct TCP escaped: {address}");
        }
        println!("{mode}: TCP {address} checked");
    }
    for address in dns_addresses {
        for transport in [DnsTransport::Udp, DnsTransport::Tcp] {
            for record in [1, 28] {
                let result = dns(address, transport, record);
                if mode == "allowed" {
                    let reply = result.unwrap_or_else(|error| {
                        panic!(
                            "host DNS positive control {address}, transport={transport:?}, type={record}: {error}"
                        )
                    });
                    assert!(
                        reply.len() >= 12 && reply[0..2] == [0x41, 0x53] && reply[2] & 0x80 != 0,
                        "invalid DNS response {reply:?}"
                    );
                } else {
                    assert!(
                        result.is_err(),
                        "DNS escaped: {address}, transport={transport:?}, type={record}"
                    );
                }
                println!("{mode}: DNS {address} transport={transport:?} type={record} checked");
            }
        }
    }
    #[cfg(windows)]
    if mode != "allowed" {
        for address in ["0.0.0.0:0", "[::]:0"] {
            assert!(
                std::net::TcpListener::bind(address).is_err(),
                "listener escaped {address}"
            );
        }
    }
    if mode == "managed" || mode == "denied" {
        let mut child_arguments = arguments.clone();
        child_arguments[0] = "descendant".into();
        assert!(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(child_arguments)
                .status()
                .unwrap()
                .success()
        );
    }
    println!("matrix-{mode}-ok");
}
