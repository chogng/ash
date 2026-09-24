use crate::AccessibilityRole;
use crate::AccessibilitySelection;
use crate::Color;
use crate::FocusBehavior;
use crate::InteractionFrame;
use crate::InteractionRegion;
use crate::NodeAction;
use crate::Rect;
use crate::UiDispatch;
use crate::UiFrame;
use zui::ui::ElementId;

const ROOT: ElementId = ElementId::scoped(120, 1);
const CHILD: ElementId = ElementId::scoped(120, 2);

#[test]
fn region_composes_inspection_and_interaction_with_one_identity() {
    let root_bounds = Rect::from_xywh(0.0, 0.0, 240.0, 120.0);
    let child_bounds = Rect::from_xywh(12.0, 16.0, 120.0, 28.0);
    let child = InteractionRegion::new(
        "ActionRegion",
        CHILD,
        child_bounds,
        AccessibilityRole::Button,
        "Open file",
    )
    .with_focus(FocusBehavior::TabStop)
    .with_action(NodeAction::Activate)
    .with_selection(AccessibilitySelection::Selected);
    let root = InteractionRegion::new(
        "PanelRegion",
        ROOT,
        root_bounds,
        AccessibilityRole::Group,
        "File panel",
    )
    .with_children([child]);
    let mut frame = UiFrame::<InteractionFrame>::at(Color::WHITE, std::time::Instant::now());

    frame.draw_component(&root);

    let accessibility = frame
        .interaction()
        .accessibility_nodes(&UiDispatch::default());
    let child_accessibility = accessibility
        .iter()
        .find(|node| node.id == CHILD)
        .expect("child interaction node");
    assert_eq!(child_accessibility.parent, Some(ROOT));
    assert_eq!(child_accessibility.bounds, child_bounds);
    assert_eq!(child_accessibility.label, "Open file");
    assert_eq!(
        child_accessibility.selection,
        AccessibilitySelection::Selected
    );
    assert!(child_accessibility.focusable);
    assert_eq!(frame.interaction().ancestry(CHILD), vec![ROOT, CHILD]);

    let child_inspection = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.element_id() == Some(CHILD))
        .expect("child inspection node");
    assert_eq!(child_inspection.name(), "ActionRegion");
    assert_eq!(child_inspection.label(), Some("Open file"));
    assert_eq!(child_inspection.bounds(), child_bounds);
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(child_inspection.id())
            .iter()
            .map(|node| node.element_id())
            .collect::<Vec<_>>(),
        vec![Some(ROOT), Some(CHILD)]
    );
}
