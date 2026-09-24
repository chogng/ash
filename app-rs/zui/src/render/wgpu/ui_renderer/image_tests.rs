use super::{ATLAS_PADDING, ATLAS_SIZE, ShelfAllocator};

#[test]
fn image_atlas_allocator_preserves_padding_and_rejects_oversized_pixels() {
    let mut allocator = ShelfAllocator::new();
    let first = allocator.allocate(10, 20).unwrap();
    let second = allocator.allocate(8, 20).unwrap();

    assert_eq!(second.x, first.x + first.width + ATLAS_PADDING);
    assert_eq!(second.y, first.y);
    assert!(allocator.allocate(ATLAS_SIZE, 1).is_none());
}
