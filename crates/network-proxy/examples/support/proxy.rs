use std::net::IpAddr;
use std::net::SocketAddr;

pub(super) fn endpoint(value: &str, scheme: &str) -> SocketAddr {
    // SDK gateway rewriting serializes HTTP URLs with a trailing slash. Parse the
    // URL while retaining the probe's literal-address and expected-protocol checks.
    let address = url::Url::parse(value).unwrap();
    assert_eq!(address.scheme(), scheme);
    assert!(address.username().is_empty() && address.password().is_none());
    assert!(matches!(address.path(), "" | "/"));
    assert!(address.query().is_none() && address.fragment().is_none());
    let ip = match address.host().unwrap() {
        url::Host::Ipv4(ip) => IpAddr::V4(ip),
        url::Host::Ipv6(ip) => IpAddr::V6(ip),
        // Non-special schemes such as socks5h retain IPv4 literals as domains.
        url::Host::Domain(host) => host
            .parse()
            .expect("proxy endpoint must use a literal IP address"),
    };
    SocketAddr::new(ip, address.port_or_known_default().unwrap())
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
