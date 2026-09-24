//! Recursive Workbench split-layout tests.

use super::{PaneGroupId, PaneInput, PanePart, PaneSplitDirection};

#[test]
fn a_layout_starts_with_one_active_group() {
    let layout = PanePart::new();

    assert_eq!(layout.group_ids(), [PaneGroupId::ROOT]);
    assert_eq!(layout.active_group(), PaneGroupId::ROOT);
}

#[test]
fn splitting_active_group_creates_a_new_active_sibling() {
    let mut layout = PanePart::new();

    let second = layout.split_active(PaneSplitDirection::Horizontal);

    assert_eq!(layout.group_ids(), [PaneGroupId::ROOT, second]);
    assert_eq!(layout.active_group(), second);
}

#[test]
fn nested_split_and_close_collapse_the_owning_split() {
    let mut layout = PanePart::new();
    let second = layout.split_active(PaneSplitDirection::Horizontal);
    let third = layout.split_active(PaneSplitDirection::Vertical);

    assert_eq!(layout.group_ids(), [PaneGroupId::ROOT, second, third]);
    assert_eq!(layout.close_active().map(|(id, _)| id), Some(third));
    assert_eq!(layout.group_ids(), [PaneGroupId::ROOT, second]);
    assert_eq!(layout.active_group(), second);
}

#[test]
fn the_last_group_cannot_be_closed() {
    let mut layout = PanePart::new();

    assert!(layout.close_active().is_none());
    assert_eq!(layout.group_ids(), [PaneGroupId::ROOT]);
}

#[test]
fn focus_wraps_over_visual_group_order() {
    let mut layout = PanePart::new();
    let second = layout.split_active(PaneSplitDirection::Horizontal);
    let third = layout.split_active(PaneSplitDirection::Vertical);

    assert_eq!(layout.focus_previous(), second);
    assert_eq!(layout.focus_previous(), PaneGroupId::ROOT);
    assert_eq!(layout.focus_previous(), third);
    assert_eq!(layout.focus_next(), PaneGroupId::ROOT);
}

#[test]
fn split_ratio_is_stored_in_the_logical_tree() {
    let mut layout = PanePart::with_input(PaneInput::settings());
    layout.split_active(PaneSplitDirection::Horizontal);
    let split_id = match layout.tree() {
        super::PaneNode::Split { id, .. } => *id,
        super::PaneNode::Leaf(_) => panic!("split should create a logical split"),
    };

    assert!(layout.set_split_ratio(split_id, 0.7));
    assert!(!layout.set_split_ratio(split_id, f32::NAN));
    match layout.tree() {
        super::PaneNode::Split { ratio, .. } => assert_eq!(*ratio, 0.7),
        super::PaneNode::Leaf(_) => panic!("split should remain in the logical tree"),
    }
}
