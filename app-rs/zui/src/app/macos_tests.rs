use super::ProtocolScheme;
use super::macos::accepted_protocol_url;

#[test]
fn platform_urls_only_admit_registered_schemes() {
    let accepted = [ProtocolScheme::new("sample-app").unwrap()];

    assert_eq!(
        accepted_protocol_url(&accepted, "SAMPLE-APP://open/settings")
            .unwrap()
            .as_str(),
        "sample-app://open/settings"
    );
    assert!(accepted_protocol_url(&accepted, "other://open/settings").is_none());
    assert!(accepted_protocol_url(&accepted, "not an absolute URL").is_none());
}
