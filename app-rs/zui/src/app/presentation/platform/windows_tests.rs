use super::version_supports_emoji_panel;

#[test]
fn emoji_panel_starts_with_windows_10_rs4() {
    assert!(!version_supports_emoji_panel(6, 9_600));
    assert!(!version_supports_emoji_panel(10, 17_133));
    assert!(version_supports_emoji_panel(10, 17_134));
    assert!(version_supports_emoji_panel(11, 0));
}
