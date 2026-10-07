use super::Insets;
use super::RectExt;
use super::bottom_anchored_area;
use ratatui::layout::Rect;

#[test]
fn popup_area_is_clamped_and_anchored_to_its_parent_bottom() {
    let parent = Rect::new(5, 7, 80, 6);

    assert_eq!(bottom_anchored_area(parent, 4), Rect::new(5, 9, 80, 4));
    assert_eq!(bottom_anchored_area(parent, 99), parent);
}

#[test]
fn inset_applies_each_edge_and_saturates_small_areas() {
    let area = Rect::new(5, 7, 20, 10);

    assert_eq!(area.inset(Insets::tlbr(1, 2, 3, 4)), Rect::new(7, 8, 14, 6));
    assert_eq!(
        area.inset(Insets::tlbr(20, 20, 20, 20)),
        Rect::new(25, 27, 0, 0)
    );
}
