use super::{TreeItem, TreeItemExpansion, TreeView, TreeViewStyle};
use crate::{
    Color, PaintRect, Point, Rect, ScrollAxis, ScrollCommand, ScrollDelta, ScrollState,
    ScrollViewStyle, ScrollbarStyle, Size, UiScene, VirtualListLayout,
};

fn style() -> TreeViewStyle {
    TreeViewStyle::new(
        ScrollViewStyle::new(ScrollbarStyle::new(
            Color::TRANSPARENT,
            Color::rgb(126, 126, 132),
        )),
        24.0,
    )
}

#[test]
fn depth_and_expansion_produce_disclosure_and_content_geometry() {
    let items = [
        TreeItem::new(0, TreeItemExpansion::Expanded),
        TreeItem::new(1, TreeItemExpansion::Leaf),
        TreeItem::new(1, TreeItemExpansion::Collapsed),
    ];
    let tree = TreeView::new(
        Rect::from_xywh(10.0, 20.0, 200.0, 72.0),
        &items,
        ScrollState::default(),
        style(),
    );

    let root = tree.item_layout(0).unwrap();
    let leaf = tree.item_layout(1).unwrap();
    assert_eq!(
        root.disclosure_bounds(),
        Some(Rect::from_xywh(10.0, 24.0, 16.0, 16.0))
    );
    assert_eq!(
        root.content_bounds(),
        Rect::from_xywh(30.0, 20.0, 180.0, 24.0)
    );
    assert_eq!(leaf.disclosure_bounds(), None);
    assert_eq!(
        leaf.content_bounds(),
        Rect::from_xywh(42.0, 44.0, 168.0, 24.0)
    );
    assert_eq!(tree.disclosure_at(Point::new(18.0, 28.0)), Some(0));
    assert_eq!(tree.disclosure_at(Point::new(34.0, 52.0)), None);
}

#[test]
fn tree_draw_only_projects_virtualized_rows() {
    let items = (0..1_000)
        .map(|index| {
            TreeItem::new(
                index % 3,
                if index % 5 == 0 {
                    TreeItemExpansion::Collapsed
                } else {
                    TreeItemExpansion::Leaf
                },
            )
        })
        .collect::<Vec<_>>();
    let mut state = ScrollState::default();
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(48.0)),
        crate::ScrollMetrics::new(Size::new(200.0, 48.0), Size::new(200.0, 24_000.0)),
        ScrollAxis::Vertical,
    );
    let tree = TreeView::new(
        Rect::from_xywh(0.0, 0.0, 200.0, 48.0),
        &items,
        state,
        style(),
    )
    .with_overscan_items(1);
    let mut scene = UiScene::new(Color::WHITE);
    let mut projected = Vec::new();

    tree.draw(&mut scene, |scene, item| {
        projected.push(item.index());
        scene.draw_rect(PaintRect::new(item.bounds(), Color::WHITE));
    });

    assert_eq!(tree.visible_range(), 2..4);
    assert_eq!(projected, vec![1, 2, 3, 4]);
    assert!(scene.rects().len() < 10);
}

#[test]
fn variable_extent_tree_centers_disclosures_in_expanded_editor_items() {
    let items = [
        TreeItem::new(0, TreeItemExpansion::Expanded),
        TreeItem::new(1, TreeItemExpansion::Collapsed),
        TreeItem::new(1, TreeItemExpansion::Leaf),
    ];
    let tree = TreeView::from_layout(
        Rect::from_xywh(0.0, 0.0, 240.0, 100.0),
        &items,
        VirtualListLayout::variable([24.0, 120.0, 30.0]),
        ScrollState::default(),
        style(),
    );

    assert_eq!(tree.visible_range(), 0..2);
    assert_eq!(
        tree.item_layout(1).unwrap().bounds(),
        Rect::from_xywh(0.0, 24.0, 240.0, 120.0)
    );
    assert_eq!(
        tree.item_layout(1).unwrap().disclosure_bounds(),
        Some(Rect::from_xywh(12.0, 76.0, 16.0, 16.0))
    );
}

#[test]
fn subtree_splice_updates_only_the_flattened_variable_extent_range() {
    let mut layout = VirtualListLayout::variable([24.0, 24.0]);
    let retained_clone = layout.clone();

    layout.splice_item_extents(1..1, [48.0, 72.0]);
    let expanded_items = [
        TreeItem::new(0, TreeItemExpansion::Expanded),
        TreeItem::new(1, TreeItemExpansion::Leaf),
        TreeItem::new(1, TreeItemExpansion::Leaf),
        TreeItem::new(0, TreeItemExpansion::Leaf),
    ];
    let expanded = TreeView::from_layout(
        Rect::from_xywh(0.0, 0.0, 240.0, 200.0),
        &expanded_items,
        layout.clone(),
        ScrollState::default(),
        style(),
    );

    assert_eq!(expanded.layout().content_extent(), 168.0);
    assert_eq!(expanded.item_layout(3).unwrap().bounds().origin.y, 144.0);
    assert_eq!(retained_clone.content_extent(), 48.0);

    layout.splice_item_extents(1..3, []);
    assert_eq!(layout, retained_clone);
}
