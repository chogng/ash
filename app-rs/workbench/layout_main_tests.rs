use super::InspectorLayoutSpec;
use super::MainLayout;
use super::PartVisibility;
use zui::ui::Rect;

fn inspector(visibility: PartVisibility) -> InspectorLayoutSpec {
    InspectorLayoutSpec::new(visibility, 320.0, 240.0, 560.0, 240.0)
}

#[test]
fn collapsed_inspector_projects_only_the_active_main_leaf() {
    let bounds = Rect::from_xywh(200.0, 32.0, 800.0, 668.0);

    let layout = MainLayout::for_bounds(bounds, inspector(PartVisibility::Collapsed));

    assert_eq!(layout.active_pane_bounds(), bounds);
    assert_eq!(layout.inspector_bounds(), None);
}

#[test]
fn expanded_inspector_is_the_rightmost_grid_leaf() {
    let bounds = Rect::from_xywh(200.0, 32.0, 800.0, 668.0);

    let layout = MainLayout::for_bounds(bounds, inspector(PartVisibility::Expanded));

    assert_eq!(
        layout.active_pane_bounds(),
        Rect::from_xywh(200.0, 32.0, 480.0, 668.0)
    );
    assert_eq!(
        layout.inspector_bounds(),
        Some(Rect::from_xywh(680.0, 32.0, 320.0, 668.0))
    );
    assert_eq!(
        layout.inspector_sash_track(),
        Some(Rect::from_xywh(680.0, 32.0, 0.0, 668.0))
    );
    let snapshot = layout
        .inspector_resize_snapshot()
        .expect("expanded inspector should expose a resize snapshot");
    let resize = snapshot.resize(0.0);
    assert_eq!(resize.previous_index(), 0);
    assert_eq!(resize.next_index(), 1);
    assert_eq!(resize.next_size(), 320.0);
}

#[test]
fn constrained_grid_omits_the_expanded_inspector_leaf() {
    let bounds = Rect::from_xywh(0.0, 32.0, 479.0, 668.0);

    let layout = MainLayout::for_bounds(bounds, inspector(PartVisibility::Expanded));

    assert_eq!(layout.active_pane_bounds(), bounds);
    assert_eq!(layout.inspector_bounds(), None);
}
