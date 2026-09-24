use super::super::view_tree::ROW_HEIGHT;
use super::super::view_tree::TOOLBAR_HEIGHT;
use super::super::view_tree::computed_bounds;
use super::super::view_tree::tree_bounds;
use super::ToolbarAction;
use super::TreeHit;
use super::compose;
use super::decorate_product_scene;
use super::toolbar_action_at;
use super::tree_hit_at;
use super::tree_rows;
use crate::devtools::DevToolsHandle;
use crate::devtools::InspectionSelection;
use crate::ui::Color;
use crate::ui::Edges;
use crate::ui::Element;
use crate::ui::InspectionFrame;
use crate::ui::InspectionNode;
use crate::ui::Point;
use crate::ui::Rect;
use crate::ui::Size;
use crate::ui::UiScene;

#[test]
fn default_view_paints_title_and_selection_metadata() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::column("Panel").in_bounds(Rect::from_xywh(0.0, 0.0, 120.0, 80.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("Button")
                    .padding(Edges::new(1.0, 2.0, 3.0, 4.0))
                    .in_bounds(Rect::from_xywh(10.0, 10.0, 80.0, 30.0))
                    .with_inspection_label("Run"),
                |_, _| {},
            );
        },
    );
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(source.inspection().clone());
    handle.toggle_picking();
    handle.set_hovered(InspectionSelection::at(
        source.inspection(),
        Point::new(20.0, 20.0),
    ));
    let scene = compose(
        Size::new(420.0, 520.0),
        handle.inspection().as_ref(),
        &handle,
    );
    let texts = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(!texts.contains(&"ZUI DevTools"));
    assert!(texts.contains(&"Styles"));
    assert!(texts.contains(&"Elements"));
    assert!(texts.contains(&"Computed"));
    assert!(!texts.iter().any(|text| text.contains("Select Pick")));
    assert!(
        !texts
            .iter()
            .any(|text| text.contains("nodes in the latest frame"))
    );
    assert!(texts.iter().any(|text| text.contains("Button")));
    assert!(texts.iter().any(|text| text.contains("size 80 × 30")));
    assert!(texts.iter().any(|text| text.contains("position 10, 10")));
    assert!(texts.iter().any(|text| text.contains("Box model")));
    assert!(texts.iter().any(|text| text.contains("padding-top")));
    assert!(texts.iter().any(|text| text.contains("padding-bottom")));
    assert!(texts.contains(&"margin"));
    assert!(texts.contains(&"border"));
    assert!(texts.contains(&"padding"));
    assert!(texts.contains(&"content"));
    assert!(texts.contains(&"74 × 26"));
    let icons = scene
        .icons()
        .iter()
        .map(|icon| icon.icon().id().as_str())
        .collect::<Vec<_>>();
    assert!(icons.contains(&"zui-devtools-pick"));
    assert!(icons.contains(&"zui-devtools-close"));
    assert!(icons.contains(&"zui-devtools-expanded"));
}

#[test]
fn default_view_hit_tests_toolbar_and_full_tree_rows() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::column("Panel").in_bounds(Rect::from_xywh(0.0, 0.0, 120.0, 80.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("Button").in_bounds(Rect::from_xywh(10.0, 10.0, 80.0, 30.0)),
                |_, _| {},
            );
        },
    );
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(source.inspection().clone());
    let frame = handle.inspection().expect("inspection frame");
    let root = frame.nodes()[0].id();
    let child = frame.nodes()[1].id();
    let bounds = Rect::from_xywh(0.0, 0.0, 420.0, 520.0);
    assert_eq!(
        toolbar_action_at(bounds, Point::new(45.0, 23.0)),
        Some(ToolbarAction::Pick)
    );
    assert_eq!(
        toolbar_action_at(bounds, Point::new(370.0, 23.0)),
        Some(ToolbarAction::Close)
    );
    assert_eq!(tree_rows(&frame, &handle).len(), 2);
    assert_eq!(
        tree_hit_at(
            bounds,
            Point::new(20.0, TOOLBAR_HEIGHT + 10.0),
            &frame,
            &handle,
        ),
        Some(TreeHit::Toggle(root))
    );
    assert_eq!(
        tree_hit_at(
            bounds,
            Point::new(45.0, TOOLBAR_HEIGHT + 10.0),
            &frame,
            &handle,
        ),
        Some(TreeHit::Select(root))
    );
    assert_eq!(
        tree_hit_at(
            bounds,
            Point::new(200.0, TOOLBAR_HEIGHT + 10.0),
            &frame,
            &handle,
        ),
        Some(TreeHit::Select(root))
    );
    handle.set_hovered_tree_node(Some(root));
    assert_eq!(
        tree_hit_at(
            bounds,
            Point::new(45.0, TOOLBAR_HEIGHT + ROW_HEIGHT + 10.0),
            &frame,
            &handle,
        ),
        Some(TreeHit::Select(child))
    );
    let scene = compose(Size::new(420.0, 520.0), Some(&frame), &handle);
    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(text.iter().any(|value| value.contains("Panel")));
    assert!(text.iter().any(|value| value.contains("Button")));
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == Color::rgb(237, 237, 241))
    );

    handle.toggle_node_expansion(root);
    assert_eq!(tree_rows(&frame, &handle).len(), 1);
    assert_eq!(
        tree_hit_at(
            bounds,
            Point::new(20.0, TOOLBAR_HEIGHT + 10.0),
            &frame,
            &handle,
        ),
        Some(TreeHit::Toggle(root))
    );
}

#[test]
fn default_view_splits_elements_tree_from_computed_panel() {
    let content = Rect::from_xywh(0.0, TOOLBAR_HEIGHT, 900.0, 640.0);
    let tree = tree_bounds(content);
    let computed = computed_bounds(content);

    assert_eq!(computed.size.width, 320.0);
    assert_eq!(computed.origin.x, tree.right() + 1.0);
    assert!(tree.size.width > computed.size.width);
}

#[test]
fn full_tree_keeps_nodes_with_a_disconnected_parent_reference_visible() {
    let mut foreign_frame = InspectionFrame::default();
    foreign_frame.register(
        InspectionNode::new("ForeignRoot", Rect::from_xywh(0.0, 0.0, 10.0, 10.0)),
        None,
        0,
        "foreign.rs",
        1,
    );
    let foreign_parent = foreign_frame.register(
        InspectionNode::new("ForeignParent", Rect::from_xywh(0.0, 0.0, 10.0, 10.0)),
        None,
        0,
        "foreign.rs",
        2,
    );
    let mut frame = InspectionFrame::default();
    frame.register(
        InspectionNode::new("Orphan", Rect::from_xywh(0.0, 0.0, 10.0, 10.0)),
        Some(foreign_parent),
        0,
        "orphan.rs",
        1,
    );
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(frame.clone());

    let rows = tree_rows(&frame, &handle);

    assert_eq!(rows.len(), 1);
    assert_eq!(
        frame.node(rows[0].id).map(|node| node.name()),
        Some("Orphan")
    );
}

#[test]
fn hovering_a_descendant_reveals_collapsed_ancestors() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::column("Panel").in_bounds(Rect::from_xywh(0.0, 0.0, 120.0, 80.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("Button").in_bounds(Rect::from_xywh(10.0, 10.0, 80.0, 30.0)),
                |_, _| {},
            );
        },
    );
    let frame = source.inspection().clone();
    let root = frame.nodes()[0].id();
    let selection = InspectionSelection::from_node(&frame, frame.nodes()[1].id())
        .expect("child should be selectable");
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(frame.clone());
    handle.toggle_node_expansion(root);
    assert_eq!(tree_rows(&frame, &handle).len(), 1);

    handle.toggle_picking();
    handle.set_hovered(Some(selection));

    assert_eq!(tree_rows(&frame, &handle).len(), 2);
}

#[test]
fn selecting_a_deep_node_scrolls_it_into_view() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::column("Panel").in_bounds(Rect::from_xywh(0.0, 0.0, 120.0, 320.0)),
        |scene, _| {
            for index in 0..6 {
                scene.with_element(
                    Element::leaf("Item").in_bounds(Rect::from_xywh(
                        0.0,
                        index as f32 * 40.0,
                        80.0,
                        30.0,
                    )),
                    |_, _| {},
                );
            }
        },
    );
    let frame = source.inspection().clone();
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(frame.clone());
    let selection = InspectionSelection::from_node(&frame, frame.nodes()[6].id())
        .expect("last child should be selectable");
    handle.select(Some(selection));

    let _ = compose(Size::new(420.0, 250.0), Some(&frame), &handle);

    assert!(handle.scroll_offset() > 0.0);
}

#[test]
fn hover_and_locked_selection_decorate_the_product_scene() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::leaf("Button").in_bounds(Rect::from_xywh(10.0, 10.0, 80.0, 30.0)),
        |_, _| {},
    );
    let selection = InspectionSelection::at(source.inspection(), Point::new(20.0, 20.0))
        .expect("point should select a node");
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(source.inspection().clone());
    handle.toggle_picking();
    handle.set_hovered(Some(selection.clone()));

    let hovered = decorate_product_scene(&source, &handle).expect("hover should decorate");
    assert!(hovered.rects().len() > source.rects().len());

    handle.set_hovered(None);
    assert!(decorate_product_scene(&source, &handle).is_none());

    handle.set_hovered(Some(selection.clone()));
    handle.select(Some(selection));
    let locked = decorate_product_scene(&source, &handle).expect("selection should decorate");
    assert!(locked.rects().len() > source.rects().len());
}

#[test]
fn tree_hover_decorates_the_corresponding_product_node_without_locking_it() {
    let mut source = UiScene::new(Color::TRANSPARENT);
    source.with_element(
        Element::column("Panel").in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 100.0)),
        |scene, _| {
            scene.with_element(
                Element::leaf("First").in_bounds(Rect::from_xywh(0.0, 0.0, 40.0, 30.0)),
                |_, _| {},
            );
            scene.with_element(
                Element::leaf("Second").in_bounds(Rect::from_xywh(0.0, 50.0, 40.0, 30.0)),
                |_, _| {},
            );
        },
    );
    let frame = source.inspection().clone();
    let first = frame.nodes()[1].id();
    let second = frame.nodes()[2].id();
    let second_bounds = frame.node(second).expect("second node").bounds();
    let handle = DevToolsHandle::new();
    handle.open();
    handle.set_inspection(frame.clone());
    handle.select(Some(
        InspectionSelection::from_node(&frame, first).expect("first node should be selectable"),
    ));

    handle.set_hovered_tree_node(Some(second));

    let hovered = decorate_product_scene(&source, &handle).expect("hover should decorate");
    assert!(
        hovered
            .rects()
            .iter()
            .any(|rect| rect.bounds() == second_bounds)
    );
    assert_eq!(
        handle
            .selection()
            .and_then(|selection| selection.target().map(|node| node.id())),
        Some(first)
    );

    handle.set_hovered_tree_node(None);
    let restored = decorate_product_scene(&source, &handle).expect("locked selection should stay");
    assert!(
        !restored
            .rects()
            .iter()
            .any(|rect| rect.bounds() == second_bounds)
    );
}
