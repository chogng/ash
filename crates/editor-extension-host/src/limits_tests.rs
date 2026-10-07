use std::time::Duration;

use super::ExtensionHostLimits;

#[test]
fn defaults_are_bounded_and_valid() {
    let limits = ExtensionHostLimits::default();
    limits.validate().unwrap();
    assert!(limits.maximum_payload_bytes < limits.maximum_frame_bytes);
    assert!(!limits.request_timeout.is_zero());
}

#[test]
fn rejects_payload_limit_larger_than_frame() {
    let mut limits = ExtensionHostLimits::default();
    limits.maximum_payload_bytes = limits.maximum_frame_bytes + 1;
    assert!(limits.validate().is_err());

    limits.maximum_payload_bytes = 1;
    limits.request_timeout = Duration::ZERO;
    assert!(limits.validate().is_err());
}
