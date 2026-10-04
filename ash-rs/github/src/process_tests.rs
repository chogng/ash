use super::*;

#[test]
fn included_http_response_accepts_gh_line_endings_and_preserves_body_bytes() {
    for headers in [
        "HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
    ] {
        let body = b"{\"body\":\"HTTP/2.0 403 is issue text\"}\n";
        let mut output = headers.as_bytes().to_vec();
        output.extend_from_slice(body);
        assert_eq!(api_response(output).unwrap(), body);
    }
}

#[test]
fn included_response_classifies_refusals_without_reading_private_bodies() {
    assert_eq!(
        api_response(
            b"HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\r\n\r\nprivate-token".to_vec()
        ),
        Err(Error::RateLimited),
    );
    assert_eq!(
        api_response(b"HTTP/2.0 401 Unauthorized\n\r\nprivate-token".to_vec()),
        Err(Error::AuthenticationRequired),
    );
}

#[test]
fn malformed_http_headers_are_rejected_without_accepting_the_body() {
    for output in [
        b"HTTP/2.0 invalid\n\r\n[]".as_slice(),
        b"HTTP/2.0 200 OK\nBroken header\r\n\r\n[]".as_slice(),
        b"HTTP/2.0 200 OK\nContent-Type: application/json".as_slice(),
    ] {
        assert!(matches!(
            api_response(output.to_vec()),
            Err(Error::InvalidResponse(_))
        ));
    }
}
