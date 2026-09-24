use super::{WindowChrome, WindowControlInsets, apply_window_chrome, window_control_insets};
use winit::window::WindowAttributes;

#[test]
fn chrome_policy_preserves_product_window_attributes() {
    let attributes = WindowAttributes::default()
        .with_title("Product title")
        .with_resizable(false);

    for chrome in [WindowChrome::Native, WindowChrome::ContentUnderTitlebar] {
        let configured = apply_window_chrome(attributes.clone(), chrome);
        assert_eq!(configured.title, "Product title");
        assert!(!configured.resizable);
    }
}

#[test]
fn control_insets_normalize_invalid_logical_widths() {
    assert_eq!(
        WindowControlInsets::from_logical_sides(-10.0, f32::NAN),
        WindowControlInsets::NONE
    );
}

#[test]
fn native_chrome_never_overlaps_product_content() {
    assert_eq!(
        window_control_insets(WindowChrome::Native),
        WindowControlInsets::NONE
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_content_under_titlebar_reserves_the_traffic_light_region() {
    assert_eq!(
        window_control_insets(WindowChrome::ContentUnderTitlebar),
        WindowControlInsets::from_logical_sides(70.0, 0.0)
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn content_under_titlebar_keeps_native_controls_outside_product_content() {
    assert_eq!(
        window_control_insets(WindowChrome::ContentUnderTitlebar),
        WindowControlInsets::NONE
    );
}
