use super::parse_known_git_bool;
use super::parse_single_null_value;

#[test]
fn parses_one_null_terminated_config_value() {
    assert_eq!(parse_single_null_value(b"true\0"), Some("true"));
    assert_eq!(parse_single_null_value(b"true"), None);
    assert_eq!(parse_single_null_value(b"true\0false\0"), None);
}

#[test]
fn recognizes_only_unambiguous_boolean_spellings_locally() {
    assert_eq!(parse_known_git_bool("TRUE"), Some(true));
    assert_eq!(parse_known_git_bool("off"), Some(false));
    assert_eq!(parse_known_git_bool("2"), None);
    assert_eq!(parse_known_git_bool("/path/to/hook"), None);
}
