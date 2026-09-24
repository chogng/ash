use super::TerminalOutputScrollView;
use ash_ui_components::ScrollbarPresentation;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{Point, Rect};

#[test]
fn bottom_relative_history_maps_to_scroll_view_content_coordinates() {
    let output = TerminalOutputScrollView::new(
        Rect::from_xywh(24.0, 56.0, 600.0, 180.0),
        30,
        18.0,
        4,
        ScrollbarPresentation::default(),
        DEFAULT_UI_THEME,
    );

    assert_eq!(output.visible_line_range(), 16..26);
    assert_eq!(
        output.scroll_view().viewport().content_origin(),
        Point::new(24.0, -232.0)
    );
}

#[test]
fn short_output_uses_the_viewport_origin_without_a_scrollbar() {
    let output = TerminalOutputScrollView::new(
        Rect::from_xywh(24.0, 56.0, 600.0, 180.0),
        2,
        18.0,
        0,
        ScrollbarPresentation::default(),
        DEFAULT_UI_THEME,
    );

    assert_eq!(output.visible_line_range(), 0..2);
    assert_eq!(
        output.scroll_view().viewport().content_origin(),
        Point::new(24.0, 56.0)
    );
    assert!(output.scroll_view().vertical_scrollbar().is_none());
}

#[test]
fn partial_line_at_viewport_bottom_does_not_shift_the_first_visible_row() {
    let output = TerminalOutputScrollView::new(
        Rect::from_xywh(24.0, 56.0, 600.0, 185.0),
        30,
        18.0,
        0,
        ScrollbarPresentation::default(),
        DEFAULT_UI_THEME,
    );

    assert_eq!(output.visible_line_range(), 20..30);
    assert_eq!(
        output.scroll_view().viewport().content_origin(),
        Point::new(24.0, -304.0)
    );
}
