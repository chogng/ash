use super::{
    composer_interaction_scroll_command, file_list_scroll_pixels, multi_diff_scroll_pixels,
    settings_scroll_command, tab_container_scroll_command,
};
use ash_ui_components::{ScrollCommand, ScrollDelta};
use zui::input::{MouseScrollDelta, PhysicalPosition};

#[test]
fn multi_diff_wheel_maps_downward_motion_to_positive_content_offset() {
    assert_eq!(
        multi_diff_scroll_pixels(MouseScrollDelta::LineDelta(0.0, -1.0)),
        54.0
    );
    assert_eq!(
        multi_diff_scroll_pixels(MouseScrollDelta::PixelDelta(PhysicalPosition::new(
            0.0, -12.0
        ))),
        12.0
    );
}

#[test]
fn file_list_line_wheel_uses_the_component_owned_row_extent() {
    assert_eq!(
        file_list_scroll_pixels(MouseScrollDelta::LineDelta(0.0, -1.0)),
        72.0
    );
    assert_eq!(
        file_list_scroll_pixels(MouseScrollDelta::PixelDelta(PhysicalPosition::new(
            0.0, -12.0
        ))),
        12.0
    );
}

#[test]
fn composer_interaction_wheel_maps_platform_delta_to_ui_scroll_command() {
    assert_eq!(
        composer_interaction_scroll_command(MouseScrollDelta::LineDelta(0.0, -1.0)),
        ScrollCommand::ByPixels(ScrollDelta::vertical(102.0))
    );
    assert_eq!(
        composer_interaction_scroll_command(MouseScrollDelta::PixelDelta(PhysicalPosition::new(
            0.0, -12.0
        ))),
        ScrollCommand::ByPixels(ScrollDelta::vertical(12.0))
    );
}

#[test]
fn tab_container_wheel_maps_downward_motion_to_vertical_scroll_command() {
    assert_eq!(
        tab_container_scroll_command(MouseScrollDelta::LineDelta(0.0, -1.0)),
        ScrollCommand::ByPixels(ScrollDelta::vertical(54.0))
    );
    assert_eq!(
        tab_container_scroll_command(MouseScrollDelta::PixelDelta(PhysicalPosition::new(
            0.0, -12.0
        ))),
        ScrollCommand::ByPixels(ScrollDelta::vertical(12.0))
    );
}

#[test]
fn settings_wheel_maps_downward_motion_to_vertical_scroll_command() {
    assert_eq!(
        settings_scroll_command(MouseScrollDelta::LineDelta(0.0, -1.0)),
        ScrollCommand::ByPixels(ScrollDelta::vertical(54.0))
    );
    assert_eq!(
        settings_scroll_command(MouseScrollDelta::PixelDelta(PhysicalPosition::new(
            0.0, -12.0
        ))),
        ScrollCommand::ByPixels(ScrollDelta::vertical(12.0))
    );
}
