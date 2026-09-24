use super::PaneGroupLayout;
use crate::PaneGroupId;
use crate::PanePart;
use crate::PaneSplitDirection;
use zui::ui::Rect;

#[test]
fn pane_tree_projects_one_leaf_and_sash_per_logical_node() {
    let mut pane_part = PanePart::new();
    let second = pane_part.split_active(PaneSplitDirection::Horizontal);
    let layout =
        PaneGroupLayout::for_tree(Rect::from_xywh(0.0, 0.0, 800.0, 600.0), pane_part.tree());

    assert_eq!(layout.leaves().len(), 2);
    assert_eq!(layout.sashes().len(), 1);
    assert!(layout.leaf(PaneGroupId::ROOT).is_some());
    assert!(layout.leaf(second).is_some());
}

#[test]
fn pane_tree_projection_uses_the_model_ratio() {
    let mut pane_part = PanePart::new();
    pane_part.split_active(PaneSplitDirection::Horizontal);
    let split_id = match pane_part.tree() {
        crate::PaneNode::Leaf(_) => panic!("split should create a split node"),
        crate::PaneNode::Split { id, .. } => *id,
    };
    assert!(pane_part.set_split_ratio(split_id, 0.75));

    let layout =
        PaneGroupLayout::for_tree(Rect::from_xywh(0.0, 0.0, 800.0, 600.0), pane_part.tree());
    let root_width = layout
        .leaf(PaneGroupId::ROOT)
        .expect("root leaf")
        .bounds()
        .size
        .width;

    assert!(root_width > 500.0);
}
