use super::ImeCursorArea;
use super::PhysicalExtent;

#[test]
fn physical_extent_preserves_platform_pixel_dimensions() {
    let extent = PhysicalExtent::new(1440, 900);

    assert_eq!(extent.width, 1440);
    assert_eq!(extent.height, 900);
}

#[test]
fn ime_cursor_area_preserves_logical_window_coordinates() {
    let area = ImeCursorArea::new(12.5, 18.0, 1.5, 20.0);

    assert_eq!(area.x, 12.5);
    assert_eq!(area.y, 18.0);
    assert_eq!(area.width, 1.5);
    assert_eq!(area.height, 20.0);
}
