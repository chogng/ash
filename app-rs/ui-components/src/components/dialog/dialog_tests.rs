use super::Dialog;
use super::DialogIds;
use super::DialogStyle;
use crate::{
    AccessibilityRole, Border, BoxShadow, Color, CornerRadii, CursorFeedback, ElementId,
    FocusBehavior, InteractionFrame, InteractionRegion, NodeAction, Point, Rect, Size, UiFrame,
};

const PARENT: ElementId = ElementId::scoped(77, 1);
const ROOT: ElementId = ElementId::scoped(77, 2);
const CHILD: ElementId = ElementId::scoped(77, 3);

fn style() -> DialogStyle {
    DialogStyle::new(Color::rgba(0, 0, 0, 72), Color::WHITE)
        .with_border(Border::uniform(1.0, Color::rgb(220, 220, 220)))
        .with_corner_radii(CornerRadii::uniform(10.0))
        .with_shadow(
            BoxShadow::new(Color::rgba(0, 0, 0, 64))
                .with_offset(Point::new(0.0, 8.0))
                .with_blur_radius(24.0),
        )
        .with_viewport_margin(24.0)
}

#[test]
fn dialog_centers_panel_and_traps_background_interaction() {
    let dialog = Dialog::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        Size::new(640.0, 400.0),
        "Settings",
        DialogIds::new(PARENT, ROOT),
        style(),
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&dialog);

    assert_eq!(dialog.bounds(), Rect::from_xywh(180.0, 150.0, 640.0, 400.0));
    assert_eq!(dialog.content_bounds(), dialog.bounds());
    assert_eq!(
        frame.scene().rects().last().unwrap().corner_radii(),
        CornerRadii::uniform(10.0)
    );
    assert!(frame.interaction().node(ROOT).is_some());
    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
}

#[test]
fn dialog_content_is_composed_under_the_modal_interaction_root() {
    let dialog = Dialog::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        Size::new(640.0, 400.0),
        "Settings",
        DialogIds::new(PARENT, ROOT),
        style(),
    );
    let child = InteractionRegion::new(
        "DialogChild",
        CHILD,
        Rect::from_xywh(220.0, 180.0, 120.0, 32.0),
        AccessibilityRole::Button,
        "Apply",
    )
    .with_cursor(CursorFeedback::Pointer)
    .with_focus(FocusBehavior::TabStop)
    .with_action(NodeAction::Activate);
    let background = InteractionRegion::new(
        "Background",
        PARENT,
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        AccessibilityRole::Group,
        "Background",
    )
    .with_focus(FocusBehavior::TabStop)
    .with_action(NodeAction::Activate);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.with_context(|context| {
        context.draw_component(&background);
        dialog.draw_components(context, |context, bounds| {
            assert_eq!(bounds, dialog.bounds());
            context.draw_component(&child);
        });
    });

    assert_eq!(frame.scene().clips().len(), 1);
    assert_eq!(frame.scene().clips()[0].bounds(), dialog.bounds());
    assert_eq!(
        frame.scene().clips()[0].corner_radii(),
        CornerRadii::uniform(10.0)
    );

    assert_eq!(
        frame.interaction().node(CHILD).unwrap().parent(),
        Some(ROOT)
    );
    assert_eq!(
        frame.interaction().target_at(Point::new(240.0, 190.0)),
        Some(CHILD)
    );
    assert_eq!(
        frame.interaction().focus_order().collect::<Vec<_>>(),
        vec![CHILD]
    );
    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
}
