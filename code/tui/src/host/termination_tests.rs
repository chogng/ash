use super::TerminationSource;

#[test]
fn termination_request_is_observed_once() {
    let source = TerminationSource::register().expect("register termination source");
    let request = source.request();
    assert!(!request.take());

    request.request();

    assert!(request.take());
    assert!(!request.take());
}
