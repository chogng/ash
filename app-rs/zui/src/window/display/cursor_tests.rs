use std::error::Error;

use super::CursorPositionError;

#[test]
fn cursor_position_errors_distinguish_unsupported_and_platform_failures() {
    let unsupported = CursorPositionError::Unsupported;
    assert!(unsupported.is_unsupported());
    assert!(unsupported.source().is_none());

    let platform = CursorPositionError::platform(std::io::Error::other("query failed"));
    assert!(!platform.is_unsupported());
    assert_eq!(platform.source().unwrap().to_string(), "query failed");
}
