use super::WindowIcon;
use crate::window::PhysicalExtent;

#[test]
fn window_icon_requires_exact_non_empty_rgba_dimensions() {
    let icon = WindowIcon::from_rgba(vec![255; 4 * 8 * 6], 8, 6).unwrap();

    assert_eq!(icon.extent(), PhysicalExtent::new(8, 6));
    assert_eq!(icon.rgba(), &[255; 4 * 8 * 6]);
    assert_eq!(icon.width(), 8);
    assert_eq!(icon.height(), 6);
    assert!(WindowIcon::from_rgba(Vec::new(), 0, 0).is_err());
    assert!(WindowIcon::from_rgba(vec![0; 3], 1, 1).is_err());
}
