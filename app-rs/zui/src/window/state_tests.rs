use super::PhysicalBounds;
use crate::window::PhysicalExtent;
use crate::window::PhysicalPosition;

#[test]
fn physical_bounds_keep_position_and_outer_extent_distinct() {
    let position = PhysicalPosition::new(-48.0, 96.0);
    let extent = PhysicalExtent::new(1280, 800);
    let bounds = PhysicalBounds::new(position, extent);

    assert_eq!(bounds.position(), position);
    assert_eq!(bounds.extent(), extent);
}
