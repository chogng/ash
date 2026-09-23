use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::num::NonZeroUsize;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

#[test]
fn header_debug_output_redacts_its_value() {
    let debug = format!("{:?}", HttpHeader::new("Authorization", "Bearer secret"));
    assert!(debug.contains("Authorization"));
    assert!(!debug.contains("Bearer secret"));
}

#[test]
fn request_rejects_a_non_http_url() {
    assert!(matches!(
        HttpRequest::post("file:///tmp/ash", Vec::new(), Vec::new()),
        Err(HttpClientError::InvalidRequest(_))
    ));
}

#[test]
fn a_transport_attempt_does_not_retry_a_retryable_status() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 503 Test\r\nContent-Length: 5\r\nConnection: close\r\n\r\nretry"
        )
        .unwrap();
    });
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{address}/catalog"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();

    let response = UreqHttpClient::new().unwrap().execute(&request).unwrap();

    assert_eq!(response.status(), 503);
    server.join().unwrap();
}

#[test]
fn plain_http_does_not_load_system_certificate_roots() {
    let root_loads = Arc::new(AtomicUsize::new(0));
    let observed_root_loads = root_loads.clone();
    let client = UreqHttpClient::with_test_system_root_loader(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        move || {
            observed_root_loads.fetch_add(1, Ordering::Relaxed);
            Err(HttpClientError::InvalidConfiguration(
                "fixture system roots unavailable".into(),
            ))
        },
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        )
        .unwrap();
    });
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{address}/offline"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();

    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    assert_eq!(root_loads.load(Ordering::Relaxed), 0);
    server.join().unwrap();
}

#[test]
fn https_loads_system_certificate_roots_lazily_and_caches_the_failure() {
    let root_loads = Arc::new(AtomicUsize::new(0));
    let observed_root_loads = root_loads.clone();
    let client = UreqHttpClient::with_test_system_root_loader(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        move || {
            observed_root_loads.fetch_add(1, Ordering::Relaxed);
            Err(HttpClientError::InvalidConfiguration(
                "fixture system roots unavailable".into(),
            ))
        },
    )
    .unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        "https://127.0.0.1:1/offline",
        Vec::new(),
        Vec::new(),
    )
    .unwrap();

    for _ in 0..2 {
        assert!(matches!(
            client.execute(&request),
            Err(HttpClientError::InvalidConfiguration(message))
                if message == "fixture system roots unavailable"
        ));
    }
    assert_eq!(root_loads.load(Ordering::Relaxed), 1);
}

#[test]
fn redirect_policy_can_reject_redirects() {
    assert_eq!(HttpClientConfig::new().redirects(), RedirectPolicy::Reject);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
    });
    let client = UreqHttpClient::with_config(
        HttpClientConfig::new().with_redirect_policy(RedirectPolicy::Reject),
    )
    .unwrap();
    let request =
        HttpRequest::post(format!("http://{address}/start"), Vec::new(), Vec::new()).unwrap();

    assert_eq!(client.execute(&request).unwrap().status(), 302);
    server.join().unwrap();
}

#[test]
fn invalid_explicit_proxy_is_rejected_without_leaking_its_credentials() {
    let proxy_url = "ftp://user:password@proxy.test:1";
    let proxy = ProxyPolicy::Explicit(proxy_url.into());
    assert!(!format!("{proxy:?}").contains("password"));
    let error = match UreqHttpClient::with_config(HttpClientConfig::new().with_proxy_policy(proxy))
    {
        Ok(_) => panic!("invalid proxy URL must be rejected"),
        Err(error) => error,
    };
    assert!(!error.to_string().contains("password"));
}

#[test]
fn proxy_bypass_rules_match_domains_ips_and_ports() {
    let bypass = ProxyBypass::from_comma_separated(".internal.example,127.0.0.1:8080,[::1]:8443");

    assert!(bypass.matches("api.internal.example", None));
    assert!(bypass.matches("internal.example", Some(443)));
    assert!(bypass.matches("127.0.0.1", Some(8080)));
    assert!(bypass.matches("::1", Some(8443)));
    assert!(!bypass.matches("127.0.0.1", Some(443)));
    assert!(!bypass.matches("public.example", Some(443)));
}

#[test]
fn explicitly_bypassed_target_connects_directly() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        )
        .unwrap();
    });
    let client = UreqHttpClient::with_config(HttpClientConfig::new().with_proxy_policy(
        ProxyPolicy::ExplicitWithBypass {
            proxy_url: "http://127.0.0.1:9".into(),
            bypass: ProxyBypass::from_comma_separated("127.0.0.1"),
        },
    ))
    .unwrap();
    let request =
        HttpRequest::post(format!("http://{address}/direct"), Vec::new(), Vec::new()).unwrap();

    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    server.join().unwrap();
}

#[test]
fn invalid_custom_trust_bundle_is_rejected_without_exposing_certificate_bytes() {
    let certificate_bytes = b"private certificate bytes".to_vec();
    let bundle = CertificateBundle::from_der(vec![certificate_bytes.clone()]).unwrap();
    assert!(!format!("{bundle:?}").contains("private certificate bytes"));

    let error = match UreqHttpClient::with_config(
        HttpClientConfig::new().with_tls_policy(TlsPolicy::CustomOnly(bundle)),
    ) {
        Ok(_) => panic!("invalid trust root must be rejected"),
        Err(error) => error,
    };
    assert!(!error.to_string().contains("private certificate bytes"));
}

#[test]
fn invalid_client_identity_is_rejected_without_exposing_private_key_bytes() {
    let certificate_chain =
        CertificateBundle::from_der(vec![b"client certificate".to_vec()]).unwrap();
    let private_key = b"private client key".to_vec();
    let identity = ClientIdentity::from_der(certificate_chain, private_key.clone()).unwrap();
    assert!(!format!("{identity:?}").contains("private client key"));

    let error = match identity.private_key() {
        Ok(_) => panic!("invalid client private key must be rejected"),
        Err(error) => error,
    };
    assert!(!error.to_string().contains("private client key"));
}

#[test]
fn unary_response_body_is_bounded_by_the_transport_configuration() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
        )
        .unwrap();
    });
    let client =
        UreqHttpClient::with_config(HttpClientConfig::new().with_response_body_limit(
            ResponseBodyLimit::new(NonZeroUsize::new(2).unwrap()).unwrap(),
        ))
        .unwrap();
    let request =
        HttpRequest::post(format!("http://{address}/body"), Vec::new(), Vec::new()).unwrap();

    assert!(matches!(
        client.execute(&request),
        Err(HttpClientError::Transport(message)) if message == "response body exceeded configured limit"
    ));
    server.join().unwrap();
}

#[test]
fn successful_response_body_is_emitted_through_the_streaming_path() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = vec![b'x'; 20 * 1024];
    let expected = body.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
    });
    let request =
        HttpRequest::post(format!("http://{address}/stream"), Vec::new(), Vec::new()).unwrap();
    let mut sink = CollectedBody::default();

    let response = UreqHttpClient::new()
        .unwrap()
        .execute_streaming(&request, &mut sink)
        .unwrap();

    assert!(response.body().is_empty());
    assert_eq!(sink.body, expected);
    assert!(sink.chunks > 1);
    server.join().unwrap();
}

#[test]
fn streaming_success_and_buffered_error_use_independent_limits() {
    let success_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let success_address = success_listener.local_addr().unwrap();
    let success_server = std::thread::spawn(move || {
        let (mut stream, _) = success_listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
        )
        .unwrap();
    });
    let error_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let error_address = error_listener.local_addr().unwrap();
    let error_server = std::thread::spawn(move || {
        let (mut stream, _) = error_listener.accept().unwrap();
        read_headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 500 Error\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
        )
        .unwrap();
    });
    let unary_limit = ResponseBodyLimit::new(NonZeroUsize::new(2).unwrap()).unwrap();
    let streaming_limit = ResponseBodyLimit::new(NonZeroUsize::new(3).unwrap()).unwrap();
    let client = UreqHttpClient::with_config(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_response_body_limit(unary_limit)
            .with_streaming_response_body_limit(streaming_limit),
    )
    .unwrap();
    let mut success_sink = CollectedBody::default();
    let success_request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{success_address}/success"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let error_request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{error_address}/error"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();

    assert_eq!(
        client
            .execute_streaming(&success_request, &mut success_sink)
            .unwrap()
            .status(),
        200
    );
    assert_eq!(success_sink.body, b"abc");
    assert!(matches!(
        client.execute_streaming(&error_request, &mut CollectedBody::default()),
        Err(HttpClientError::Transport(message)) if message == "response body exceeded configured limit"
    ));
    success_server.join().unwrap();
    error_server.join().unwrap();
}

#[test]
fn response_limit_reserves_headroom_for_overflow_detection() {
    assert!(matches!(
        ResponseBodyLimit::new(NonZeroUsize::new(usize::MAX).unwrap()),
        Err(HttpClientError::InvalidConfiguration(_))
    ));
}

#[test]
fn telemetry_hook_emits_only_safe_transport_facts() {
    let telemetry = Arc::new(CapturingTelemetry::default());
    let client = TelemetryHttpClient::new(Arc::new(StaticClient), telemetry.clone());
    let request = HttpRequest::post(
        "https://example.test/secret?token=private",
        vec![HttpHeader::new("Authorization", "Bearer secret")],
        b"request body".to_vec(),
    )
    .unwrap();

    client.execute(&request).unwrap();

    let events = telemetry.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].method, HttpMethod::Post);
    assert_eq!(
        events[0].outcome,
        HttpTransportOutcome::Response {
            status_class: HttpStatusClass::Success,
        }
    );
    assert_eq!(events[0].request_body_bytes, b"request body".len());
    assert_eq!(events[0].response_body_bytes, b"response body".len());
}

#[derive(Default)]
struct CapturingTelemetry {
    events: Mutex<Vec<HttpClientTelemetryEvent>>,
}

impl HttpClientTelemetry for CapturingTelemetry {
    fn start(&self) -> Box<dyn crate::HttpClientTelemetrySpan + '_> {
        Box::new(self)
    }
}

impl crate::HttpClientTelemetrySpan for &CapturingTelemetry {
    fn finish(self: Box<Self>, event: HttpClientTelemetryEvent) {
        self.events.lock().unwrap().push(event);
    }
}

struct StaticClient;

#[test]
fn unary_http_clients_reject_streaming_before_sending() {
    struct UnaryOnly;
    impl HttpClient for UnaryOnly {
        fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
            panic!("a streaming request must not execute a unary request")
        }
    }
    let request = HttpRequest::post("https://example.test/stream", Vec::new(), Vec::new()).unwrap();
    let mut sink = CollectedBody::default();
    assert_eq!(
        UnaryOnly.execute_streaming(&request, &mut sink),
        Err(HttpClientError::InvalidRequest(
            "HTTP client does not support streaming".into()
        ))
    );
    assert!(sink.body.is_empty());
}

impl HttpClient for StaticClient {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        Ok(HttpResponse::new(
            200,
            Vec::new(),
            b"response body".to_vec(),
        ))
    }
}

#[derive(Default)]
struct CollectedBody {
    body: Vec<u8>,
    chunks: usize,
}

impl HttpBodySink for CollectedBody {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.body.extend_from_slice(chunk);
        self.chunks += 1;
        Ok(())
    }
}

fn read_headers(stream: &mut impl Read) {
    let mut received = Vec::new();
    let mut buffer = [0; 256];
    loop {
        let bytes_read = stream.read(&mut buffer).unwrap();
        assert_ne!(
            bytes_read, 0,
            "client closed before sending request headers"
        );
        received.extend_from_slice(&buffer[..bytes_read]);
        if received.windows(4).any(|window| window == b"\r\n\r\n") {
            return;
        }
    }
}

#[test]
fn public_internet_policy_rejects_non_public_address_classes() {
    for address in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.168.0.1",
        "198.18.0.1",
        "203.0.113.1",
        "224.0.0.1",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "fec0::1",
        "::192.168.1.1",
        "64:ff9b::c0a8:101",
        "100::1",
        "2001::1",
        "2002:c0a8:101::1",
        "3fff::1",
        "5f00::1",
        "2001:db8::1",
    ] {
        assert!(
            !crate::outbound_network::is_public_internet_ip(address.parse().unwrap()),
            "{address} must not be treated as a public Internet target"
        );
    }
    assert!(crate::outbound_network::is_public_internet_ip(
        "1.1.1.1".parse().unwrap()
    ));
    assert!(crate::outbound_network::is_public_internet_ip(
        "2606:4700:4700::1111".parse().unwrap()
    ));
}

#[test]
fn public_internet_policy_requires_direct_manual_redirect_handling() {
    let ambient_proxy =
        HttpClientConfig::new().with_network_target_policy(NetworkTargetPolicy::PublicInternetOnly);
    assert!(matches!(
        UreqHttpClient::with_config(ambient_proxy),
        Err(HttpClientError::InvalidConfiguration(_))
    ));

    let direct = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_network_target_policy(NetworkTargetPolicy::PublicInternetOnly);
    assert!(UreqHttpClient::with_config(direct).is_ok());
}

#[test]
fn requests_reject_invalid_header_syntax_before_transport() {
    for header in [
        HttpHeader::new("Bad Header", "secret"),
        HttpHeader::new("X-Test", "secret\r\nInjected: yes"),
        HttpHeader::new("", "secret"),
    ] {
        let error = HttpRequest::post("https://example.test", vec![header], vec![]).unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
}
