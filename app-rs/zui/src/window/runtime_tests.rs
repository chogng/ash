use super::WindowMetrics;
use super::WindowOptions;
use crate::Size;
use crate::window::CursorIcon;
use crate::window::LogicalPosition;
use crate::window::LogicalSize;
use crate::window::PhysicalExtent;
use crate::window::Theme;
use crate::window::WindowButtons;
use crate::window::WindowIcon;
use crate::window::WindowLevel;
use crate::window::WindowOptionsError;

#[test]
fn logical_size_uses_valid_platform_scale_factor() {
    let metrics = WindowMetrics::new(PhysicalExtent::new(1440, 900), 2.0);

    assert_eq!(metrics.logical_size(), Size::new(720.0, 450.0));
}

#[test]
fn logical_size_falls_back_for_invalid_platform_scale_factor() {
    for scale_factor in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let metrics = WindowMetrics::new(PhysicalExtent::new(800, 600), scale_factor);

        assert_eq!(metrics.logical_size(), Size::new(800.0, 600.0));
        assert_eq!(metrics.scale_factor(), 1.0);
    }
}

#[test]
fn window_options_validate_all_configured_sizes() {
    let invalid = WindowOptions::new("invalid").with_inner_size(LogicalSize::new(0.0, 600.0));
    let inverted = WindowOptions::new("inverted")
        .with_min_inner_size(LogicalSize::new(800.0, 600.0))
        .with_max_inner_size(LogicalSize::new(640.0, 480.0));
    let invalid_position =
        WindowOptions::new("position").with_position(LogicalPosition::new(f64::NAN, 20.0));
    let invalid_increments =
        WindowOptions::new("increments").with_resize_increments(LogicalSize::new(8.0, 0.0));

    assert!(matches!(
        invalid.validate(),
        Err(WindowOptionsError::InvalidSize {
            field: "inner size"
        })
    ));
    assert_eq!(
        inverted.validate(),
        Err(WindowOptionsError::InvalidSizeRange)
    );
    assert_eq!(
        invalid_position.validate(),
        Err(WindowOptionsError::InvalidPosition)
    );
    assert!(matches!(
        invalid_increments.validate(),
        Err(WindowOptionsError::InvalidSize {
            field: "resize increments"
        })
    ));
}

#[test]
fn window_options_accept_independent_initial_platform_policies() {
    let options = WindowOptions::new("tool")
        .with_inner_size(LogicalSize::new(900.0, 720.0))
        .with_min_inner_size(LogicalSize::new(320.0, 240.0))
        .with_max_inner_size(LogicalSize::new(1920.0, 1080.0))
        .with_visible(false)
        .with_active(false)
        .with_resizable(false)
        .with_maximized(true)
        .with_fullscreen(false)
        .with_position(LogicalPosition::new(-120.0, 80.0))
        .with_window_level(WindowLevel::AlwaysOnTop)
        .with_resize_increments(LogicalSize::new(8.0, 16.0))
        .with_enabled_buttons(WindowButtons::ALL.with_maximize(false))
        .with_theme(Some(Theme::Dark))
        .with_content_protected(true)
        .with_cursor(CursorIcon::Text)
        .with_blur(true)
        .with_icon(WindowIcon::from_rgba(vec![255; 16], 2, 2).unwrap());

    assert_eq!(options.validate(), Ok(()));
    assert!(!options.visible);
    assert!(!options.active);
    assert!(!options.resizable);
    assert!(options.maximized);
    assert!(!options.fullscreen);
    assert_eq!(options.position, Some(LogicalPosition::new(-120.0, 80.0)));
    assert_eq!(options.window_level, WindowLevel::AlwaysOnTop);
    assert_eq!(options.resize_increments, Some(LogicalSize::new(8.0, 16.0)));
    assert_eq!(
        options.enabled_buttons,
        WindowButtons::ALL.with_maximize(false)
    );
    assert_eq!(options.preferred_theme, Some(Theme::Dark));
    assert!(options.content_protected);
    assert_eq!(options.cursor, CursorIcon::Text);
    assert!(options.transparent);
    assert!(options.blur);
    assert!(options.icon.is_some());
    assert_eq!(options.parent(), None);
    assert!(!options.is_modal());

    let opaque = options.with_transparent(false);
    assert!(!opaque.transparent);
    assert!(!opaque.blur);
}

#[test]
fn window_options_distinguish_owned_and_modal_children() {
    let parent = crate::window::WindowId::from_raw(17);
    let child = WindowOptions::new("child").with_parent(parent);
    let modal = WindowOptions::new("modal").with_modal_parent(parent);

    assert_eq!(child.parent(), Some(parent));
    assert!(!child.is_modal());
    assert_eq!(modal.parent(), Some(parent));
    assert!(modal.is_modal());
    assert_eq!(modal.validate(), Ok(()));
}
