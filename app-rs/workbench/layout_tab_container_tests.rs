use super::TabContainerLayoutSpec;
use crate::PartVisibility;
use zui::ui::Rect;

fn expanded_spec() -> TabContainerLayoutSpec {
    TabContainerLayoutSpec::new(PartVisibility::Expanded, 200.0, 160.0, 480.0, 240.0)
}

#[test]
fn expanded_tab_container_reserves_the_preferred_width() {
    let bounds = Rect::from_xywh(0.0, 32.0, 1_000.0, 668.0);
    let layout = expanded_spec().for_bounds(bounds);

    assert_eq!(
        layout
            .tab_container_bounds()
            .map(|bounds| bounds.size.width),
        Some(200.0)
    );
    assert_eq!(layout.main_bounds().origin.x, 200.0);
    assert!(layout.sash_track().is_some());
    assert!(layout.resize_snapshot().is_some());
}

#[test]
fn collapsed_or_constrained_tab_container_leaves_the_main_part() {
    let bounds = Rect::from_xywh(0.0, 32.0, 1_000.0, 668.0);
    let collapsed =
        TabContainerLayoutSpec::new(PartVisibility::Collapsed, 200.0, 160.0, 480.0, 240.0)
            .for_bounds(bounds);
    assert_eq!(collapsed.tab_container_bounds(), None);
    assert_eq!(collapsed.main_bounds(), bounds);
    assert_eq!(collapsed.sash_track(), None);

    let constrained = expanded_spec().for_bounds(Rect::from_xywh(0.0, 32.0, 399.0, 668.0));
    assert_eq!(constrained.tab_container_bounds(), None);
    assert_eq!(constrained.main_bounds().size.width, 399.0);
}
