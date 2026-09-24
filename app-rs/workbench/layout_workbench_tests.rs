use super::InspectorLayoutSpec;
use super::TabContainerLayoutSpec;
use super::WorkbenchLayoutSpec;
use super::WorkbenchPart;
use crate::{LogicalViewport, PartVisibility};
use zui::ui::Rect;

fn tab_container(visibility: PartVisibility) -> TabContainerLayoutSpec {
    TabContainerLayoutSpec::new(visibility, 200.0, 160.0, 480.0, 240.0)
}

fn inspector(visibility: PartVisibility) -> InspectorLayoutSpec {
    InspectorLayoutSpec::new(visibility, 320.0, 240.0, 560.0, 240.0)
}

fn spec(
    tab_container_visibility: PartVisibility,
    inspector_visibility: PartVisibility,
) -> WorkbenchLayoutSpec {
    WorkbenchLayoutSpec::new(
        32.0,
        tab_container(tab_container_visibility),
        inspector(inspector_visibility),
    )
}

#[test]
fn workbench_composes_titlebar_tab_container_main_and_inspector_parts() {
    let layout = spec(PartVisibility::Expanded, PartVisibility::Expanded)
        .for_viewport(LogicalViewport {
            width: 1_000.0,
            height: 700.0,
        })
        .expect("viewport should fit the Workbench");

    assert_eq!(
        layout.part_bounds(WorkbenchPart::Titlebar),
        Some(Rect::from_xywh(0.0, 0.0, 1_000.0, 32.0))
    );
    assert_eq!(
        layout.part_bounds(WorkbenchPart::SidebarView),
        Some(Rect::from_xywh(0.0, 32.0, 200.0, 668.0))
    );
    assert_eq!(
        layout.part_bounds(WorkbenchPart::Main),
        Some(Rect::from_xywh(200.0, 32.0, 480.0, 668.0))
    );
    assert_eq!(
        layout.part_bounds(WorkbenchPart::Inspector),
        Some(Rect::from_xywh(680.0, 32.0, 320.0, 668.0))
    );
}

#[test]
fn workbench_omits_collapsed_parts_without_changing_main_origin() {
    let layout = spec(PartVisibility::Collapsed, PartVisibility::Collapsed)
        .for_viewport(LogicalViewport {
            width: 1_000.0,
            height: 700.0,
        })
        .expect("viewport should fit the Workbench");

    assert_eq!(layout.tab_container(), None);
    assert_eq!(layout.inspector(), None);
    assert_eq!(layout.main(), Rect::from_xywh(0.0, 32.0, 1_000.0, 668.0));
}

#[test]
fn workbench_rejects_compact_viewports_before_mounting_parts() {
    assert!(
        spec(PartVisibility::Expanded, PartVisibility::Expanded)
            .for_viewport(LogicalViewport {
                width: 239.0,
                height: 700.0,
            })
            .is_none()
    );
    assert!(
        spec(PartVisibility::Expanded, PartVisibility::Expanded)
            .for_viewport(LogicalViewport {
                width: 1_000.0,
                height: 179.0,
            })
            .is_none()
    );
}
