use super::*;
use ash_http_client::CertificateBundle;
use ash_http_client::ProxyPolicy;
use ash_http_client::RedirectPolicy;
use ash_http_client::TlsPolicy;
use std::num::NonZeroU8;
use tough::IntoVec;

fn transport() -> HttpsTransport {
    HttpsTransport::new(
        HttpClientConfig::default()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(
                CertificateBundle::from_der(vec![http_test_support::CA_DER.to_vec()]).unwrap(),
            )),
    )
    .unwrap()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn system_roots_transport_rejects_non_https_urls() {
    let transport =
        HttpsTransport::new(HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct))
            .unwrap();
    for url in ["http://127.0.0.1/package.zip", "file:///package.zip"] {
        let error = runtime()
            .block_on(transport.fetch(Url::parse(url).unwrap()))
            .err()
            .unwrap();
        assert_eq!(error.kind(), TransportErrorKind::UnsupportedUrlScheme);
    }
}

#[test]
fn configured_tls_roots_download_https_and_preserve_not_found() {
    let server = http_test_support::Server::reply(
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npack".to_vec(),
    );
    let bytes = runtime().block_on(async {
        transport()
            .fetch(Url::parse(&format!("{}/package.zip", server.url())).unwrap())
            .await
            .unwrap()
            .into_vec()
            .await
            .unwrap()
    });
    assert_eq!(bytes, b"pack");
    assert_eq!(server.request().line, "GET /package.zip HTTP/1.1");
    for status in [403, 404, 410] {
        let server = http_test_support::Server::reply(
            format!("HTTP/1.1 {status} Missing\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes(),
        );
        let error = runtime()
            .block_on(transport().fetch(Url::parse(&server.url()).unwrap()))
            .err()
            .unwrap();
        assert_eq!(error.kind(), TransportErrorKind::FileNotFound);
        assert_eq!(server.request().line, "GET / HTTP/1.1");
    }
}

#[test]
fn configured_tls_roots_reject_http_and_redirects() {
    let error = runtime()
        .block_on(transport().fetch(Url::parse("http://127.0.0.1/package.zip").unwrap()))
        .err()
        .unwrap();
    assert_eq!(error.kind(), TransportErrorKind::UnsupportedUrlScheme);
    let server = http_test_support::Server::reply(
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/package.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    );
    assert!(
        runtime()
            .block_on(transport().fetch(Url::parse(&server.url()).unwrap()))
            .is_err()
    );
    server.request();
    server.assert_no_more_requests();
}

#[test]
fn tuf_rejects_redirects_even_when_the_http_client_allows_them() {
    let transport = HttpsTransport::new(
        HttpClientConfig::default()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(
                CertificateBundle::from_der(vec![http_test_support::CA_DER.to_vec()]).unwrap(),
            ))
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: NonZeroU8::new(2).unwrap(),
            }),
    )
    .unwrap();
    for status in [301, 302, 303, 307, 308] {
        let server = http_test_support::Server::reply(
            format!(
                "HTTP/1.1 {status} Redirect\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
        );
        let error = runtime()
            .block_on(transport.fetch(Url::parse(&server.url()).unwrap()))
            .err()
            .unwrap();
        assert_eq!(error.kind(), TransportErrorKind::Other);
        assert_eq!(server.request().line, "GET / HTTP/1.1");
        server.assert_no_more_requests();
    }
}
