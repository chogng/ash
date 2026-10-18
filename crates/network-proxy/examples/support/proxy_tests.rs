use super::endpoint;
use std::net::SocketAddr;

#[test]
fn sdk_gateway_url_accepts_the_canonical_trailing_slash() {
    let expected: SocketAddr = "10.0.2.2:3128".parse().unwrap();
    assert_eq!(endpoint("http://10.0.2.2:3128", "http"), expected);
    assert_eq!(endpoint("http://10.0.2.2:3128/", "http"), expected);
}

#[test]
fn socks_and_ipv6_proxy_urls_preserve_the_endpoint() {
    assert_eq!(
        endpoint("socks5h://10.0.2.2:3128", "socks5h"),
        "10.0.2.2:3128".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(
        endpoint("socks5h://10.0.2.2:3128/", "socks5h"),
        "10.0.2.2:3128".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(
        endpoint("http://[::1]:3128/", "http"),
        "[::1]:3128".parse::<SocketAddr>().unwrap()
    );
}

#[test]
fn proxy_url_parsing_keeps_the_probes_authority_constraints() {
    for (value, scheme) in [
        ("http://user:password@127.0.0.1:3128/", "http"),
        ("socks5h://127.0.0.1:3128/", "http"),
        ("http://localhost:3128/", "http"),
        ("http://127.0.0.1:3128/path", "http"),
        ("http://127.0.0.1:3128/?query", "http"),
        ("http://127.0.0.1:3128/#fragment", "http"),
        ("socks5h://127.0.0.1/", "socks5h"),
    ] {
        assert!(
            std::panic::catch_unwind(|| endpoint(value, scheme)).is_err(),
            "unexpected proxy endpoint accepted: {value}"
        );
    }
}
