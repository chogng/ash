use super::{GridLayout, GridNode, GridPane};
use crate::{Rect, SplitViewOrientation, SplitViewPane};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum LeafId {
    Left,
    TopRight,
    BottomRight,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SplitId {
    Root,
    Right,
}

fn pane(
    node: GridNode<LeafId, SplitId>,
    preferred: f32,
    minimum: f32,
) -> GridPane<LeafId, SplitId> {
    GridPane::new(node, SplitViewPane::new(preferred, minimum, f32::INFINITY))
}

#[test]
fn nested_grid_recursively_resolves_leaves_and_sashes() {
    let right = GridNode::split(
        SplitId::Right,
        SplitViewOrientation::Vertical,
        vec![
            pane(GridNode::leaf(LeafId::TopRight), 300.0, 100.0),
            pane(GridNode::leaf(LeafId::BottomRight), 300.0, 100.0),
        ],
    );
    let root = GridNode::split(
        SplitId::Root,
        SplitViewOrientation::Horizontal,
        vec![
            pane(GridNode::leaf(LeafId::Left), 300.0, 160.0),
            pane(right, 700.0, 240.0),
        ],
    );

    let layout = GridLayout::new(Rect::from_xywh(0.0, 0.0, 1000.0, 600.0), &root);

    assert_eq!(
        layout.leaf(LeafId::Left).unwrap().bounds(),
        Rect::from_xywh(0.0, 0.0, 300.0, 600.0)
    );
    assert_eq!(
        layout.leaf(LeafId::TopRight).unwrap().bounds(),
        Rect::from_xywh(300.0, 0.0, 700.0, 300.0)
    );
    assert_eq!(
        layout.leaf(LeafId::BottomRight).unwrap().bounds(),
        Rect::from_xywh(300.0, 300.0, 700.0, 300.0)
    );
    assert_eq!(layout.splits().len(), 2);
    assert_eq!(layout.sashes().len(), 2);
    assert_eq!(layout.sashes()[0].split_id(), SplitId::Root);
    assert_eq!(layout.sashes()[1].split_id(), SplitId::Right);
    assert_eq!(
        layout.sashes()[1].track_bounds(),
        Rect::from_xywh(300.0, 300.0, 700.0, 0.0)
    );
}

#[test]
fn grid_sash_resize_retains_its_owning_split_and_child_indices() {
    let root = GridNode::split(
        SplitId::Root,
        SplitViewOrientation::Horizontal,
        vec![
            pane(GridNode::leaf(LeafId::Left), 300.0, 160.0),
            pane(GridNode::leaf(LeafId::TopRight), 700.0, 240.0),
        ],
    );
    let layout = GridLayout::new(Rect::from_xywh(0.0, 0.0, 1000.0, 600.0), &root);
    let sash = layout.sashes()[0];

    let resized = sash.resize_snapshot().resize(100.0);

    assert_eq!(sash.split_id(), SplitId::Root);
    assert_eq!(sash.previous_index(), 0);
    assert_eq!(sash.next_index(), 1);
    assert_eq!(resized.previous_size(), 400.0);
    assert_eq!(resized.next_size(), 600.0);
}

#[test]
fn hidden_grid_pane_omits_its_subtree_and_sash() {
    let root = GridNode::split(
        SplitId::Root,
        SplitViewOrientation::Horizontal,
        vec![
            GridPane::new(
                GridNode::leaf(LeafId::Left),
                SplitViewPane::new(300.0, 160.0, 480.0).hidden(),
            ),
            pane(GridNode::leaf(LeafId::TopRight), 700.0, 240.0),
        ],
    );

    let layout = GridLayout::new(Rect::from_xywh(0.0, 0.0, 1000.0, 600.0), &root);

    assert!(layout.leaf(LeafId::Left).is_none());
    assert_eq!(
        layout.leaf(LeafId::TopRight).unwrap().bounds(),
        Rect::from_xywh(0.0, 0.0, 1000.0, 600.0)
    );
    assert!(layout.sashes().is_empty());
}

#[test]
#[should_panic(expected = "Grid split nodes must contain at least two panes")]
fn split_rejects_a_single_child() {
    let _ = GridNode::split(
        SplitId::Root,
        SplitViewOrientation::Horizontal,
        vec![pane(GridNode::leaf(LeafId::Left), 300.0, 160.0)],
    );
}

#[test]
#[should_panic(expected = "Grid leaf identities must be unique")]
fn layout_rejects_duplicate_leaf_identities() {
    let root = GridNode::split(
        SplitId::Root,
        SplitViewOrientation::Horizontal,
        vec![
            pane(GridNode::leaf(LeafId::Left), 300.0, 160.0),
            pane(GridNode::leaf(LeafId::Left), 700.0, 240.0),
        ],
    );

    let _ = GridLayout::new(Rect::from_xywh(0.0, 0.0, 1000.0, 600.0), &root);
}

#[test]
#[should_panic(expected = "Grid bounds dimensions must be non-negative and finite")]
fn leaf_root_rejects_invalid_layout_bounds() {
    let root = GridNode::<LeafId, SplitId>::leaf(LeafId::Left);

    let _ = GridLayout::new(Rect::from_xywh(0.0, 0.0, f32::NAN, 600.0), &root);
}
