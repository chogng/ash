use super::AboutPanelFuture;
use super::AboutPanelOptions;
use super::ApplicationFocusOptions;
use super::UserActivityInfo;
use super::fallback_about_request;
use super::platform;
use super::select_window_target;
use super::validate_user_activity;
use crate::window::WindowId;

fn assert_send<T: Send>() {}

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn about_panel_fallback_preserves_application_metadata() {
    let mut options = AboutPanelOptions::new()
        .with_name("Ash")
        .with_version("1.2.3")
        .with_copyright("Copyright 2026");
    options.short_version = Some("456".to_string());
    options.authors = vec!["Ada".to_string(), "Grace".to_string()];
    options.comments = Some("A native terminal".to_string());
    options.website = Some("https://example.com".to_string());
    options.website_label = Some("Homepage".to_string());

    let request = fallback_about_request(&options);

    assert_eq!(request.title(), "About Ash");
    assert_eq!(
        request.message(),
        "Version 1.2.3\nBuild 456\nAda, Grace\n\nA native terminal\nCopyright 2026\nHomepage: https://example.com"
    );
}

#[test]
fn about_panel_completion_can_cross_thread_boundaries() {
    assert_send::<AboutPanelFuture>();
}

#[test]
fn emoji_panel_support_matches_native_implementations() {
    if cfg!(target_os = "macos") {
        assert!(platform::is_emoji_panel_supported());
    }
    if cfg!(not(any(target_os = "macos", target_os = "windows"))) {
        assert!(!platform::is_emoji_panel_supported());
    }
}

#[test]
fn handoff_activity_requires_a_type_and_http_fallback_url() {
    assert_send_sync::<UserActivityInfo>();
    assert!(validate_user_activity("com.ash.session", None).is_ok());
    assert_eq!(
        validate_user_activity("com.ash.session", Some("https://ash.example/session"))
            .unwrap()
            .unwrap()
            .scheme(),
        "https"
    );
    assert!(
        validate_user_activity("  ", None)
            .unwrap_err()
            .is_invalid_input()
    );
    assert!(
        validate_user_activity("com.ash.session", Some("file:///tmp/session"))
            .unwrap_err()
            .is_invalid_input()
    );
}

#[test]
fn public_focus_options_cross_thread_boundaries() {
    assert_send_sync::<ApplicationFocusOptions>();
    let options = ApplicationFocusOptions::new().with_steal(true);
    assert!(options.steal());
}

#[test]
fn window_focus_selection_is_stable_and_platform_specific() {
    let candidates = [
        (WindowId::from_raw(30), Some(true)),
        (WindowId::from_raw(10), Some(false)),
        (WindowId::from_raw(20), None),
    ];
    assert_eq!(
        select_window_target(false, candidates),
        Some(WindowId::from_raw(10))
    );
    assert_eq!(
        select_window_target(true, candidates),
        Some(WindowId::from_raw(20))
    );
}

#[test]
fn visible_window_policy_rejects_only_explicitly_hidden_windows() {
    let hidden = [(WindowId::from_raw(1), Some(false))];
    assert_eq!(select_window_target(true, hidden), None);
    let unknown = [(WindowId::from_raw(1), None)];
    assert_eq!(
        select_window_target(true, unknown),
        Some(WindowId::from_raw(1))
    );
}
