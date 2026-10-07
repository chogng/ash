use super::*;

fn retry_header(value: &str) -> Vec<HttpHeader> {
    vec![HttpHeader::new("Retry-After", value)]
}

#[test]
fn retry_delay_starts_when_headers_arrive() {
    let received_at = ResponseReceivedAt {
        monotonic: Instant::now() - Duration::from_secs(2),
        wall: SystemTime::now() - Duration::from_secs(2),
    };
    let response = HttpResponse::with_received_at(429, retry_header("3"), Vec::new(), received_at);
    let remaining = response.retry_after().unwrap();
    assert_eq!(
        response.retry_after_deadline(),
        Some(received_at.monotonic + Duration::from_secs(3))
    );
    assert!(remaining <= Duration::from_secs(1));
}

#[test]
fn retry_after_http_date_uses_the_header_receipt_clock() {
    let received_at = ResponseReceivedAt::now();
    let date = httpdate::fmt_http_date(received_at.wall + Duration::from_secs(10));
    let response =
        HttpResponse::with_received_at(429, retry_header(&date), Vec::new(), received_at);
    let remaining = response.retry_after().unwrap();
    assert!(remaining > Duration::from_secs(8));
    assert!(remaining <= Duration::from_secs(10));
}

#[test]
fn expired_retry_date_is_zero_delay_and_invalid_advice_is_absent() {
    let received_at = ResponseReceivedAt::now();
    let expired = httpdate::fmt_http_date(received_at.wall - Duration::from_secs(1));
    let response =
        HttpResponse::with_received_at(429, retry_header(&expired), Vec::new(), received_at);
    assert_eq!(response.retry_after(), Some(Duration::ZERO));
    let invalid = HttpResponse::new(429, retry_header("later"), Vec::new());
    assert_eq!(invalid.retry_after_deadline(), None);
}
