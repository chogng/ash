use std::ffi::OsString;

use super::ProtocolScheme;
use super::ProtocolUrl;
use super::urls_from_arguments;

#[test]
fn schemes_are_validated_and_normalized() {
    assert_eq!(
        ProtocolScheme::new("Ash+Agent").unwrap().as_str(),
        "ash+agent"
    );
    assert!(ProtocolScheme::new("1ash").is_err());
    assert!(ProtocolScheme::new("ash agent").is_err());
    assert!(ProtocolScheme::new("").is_err());
}

#[test]
fn protocol_urls_retain_absolute_serialization_and_scheme() {
    let url = ProtocolUrl::parse("ash://workspace/open?id=41").unwrap();
    assert_eq!(url.scheme().as_str(), "ash");
    assert_eq!(url.as_str(), "ash://workspace/open?id=41");
    assert!(ProtocolUrl::parse("relative/path").is_err());
}

#[test]
fn launch_arguments_only_capture_explicitly_accepted_schemes() {
    let urls = urls_from_arguments(
        &[ProtocolScheme::new("ash").unwrap()],
        [
            OsString::from("--verbose"),
            OsString::from("https://example.com"),
            OsString::from("ash://workspace/open"),
        ],
    );
    assert_eq!(urls.len(), 1);
    assert_eq!(urls[0].as_str(), "ash://workspace/open");
}
