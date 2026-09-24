use super::TITLEBAR;
use super::TITLEBAR_SETTINGS_BUTTON;
use super::Titlebar;
use super::TitlebarInsets;
use crate::Color;
use crate::Point;
use crate::Rect;
use crate::sidebarpart::test_style;
use crate::{CHANGES_PANE_BUTTON, TAB_CONTAINER_TOGGLE};
use ash_icons::icons;
use zui::ui::InteractionFrame;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;
use zui::ui::UiIntent;

#[test]
fn collapsed_sidebar_keeps_titlebar_actions() {
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);
    let mut dispatch = UiDispatch::default();
    let titlebar = Titlebar::new(
        Rect::from_xywh(0.0, 0.0, 1000.0, 32.0),
        test_style(),
        false,
        TitlebarInsets::new(70.0, 110.0),
        &dispatch,
    );
    frame.draw_component(&titlebar);

    assert_eq!(frame.scene().icons().len(), 3);
    assert_eq!(
        frame.scene().icons()[0].icon(),
        icons::LAYOUT_SIDEBAR_LEFT_OFF_EMPTY
    );
    assert_eq!(frame.scene().icons()[1].icon(), icons::DIFF);
    assert_eq!(frame.scene().icons()[2].icon(), icons::GEAR);
    assert!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .all(|text| text.text() != "Settings")
    );

    dispatch.pointer_moved(Point::new(400.0, 16.0), frame.interaction());
    assert_eq!(
        dispatch.press_primary(frame.interaction()).intent,
        Some(UiIntent::StartWindowDrag(TITLEBAR))
    );

    dispatch.pointer_moved(Point::new(83.0, 16.0), frame.interaction());
    dispatch.press_primary(frame.interaction());
    assert!(dispatch.is_pressed(TAB_CONTAINER_TOGGLE));
    assert_eq!(
        dispatch
            .release_primary(Point::new(83.0, 16.0), frame.interaction())
            .intent,
        Some(UiIntent::Activate(TAB_CONTAINER_TOGGLE))
    );

    let settings_bounds = frame
        .interaction()
        .node(TITLEBAR_SETTINGS_BUTTON)
        .expect("collapsed Sidebar keeps Settings available")
        .bounds();
    let settings_point = Point::new(
        settings_bounds.origin.x + settings_bounds.size.width * 0.5,
        settings_bounds.origin.y + settings_bounds.size.height * 0.5,
    );
    dispatch.pointer_moved(settings_point, frame.interaction());
    dispatch.press_primary(frame.interaction());
    assert_eq!(
        dispatch
            .release_primary(settings_point, frame.interaction())
            .intent,
        Some(UiIntent::Activate(TITLEBAR_SETTINGS_BUTTON))
    );

    let changes_bounds = frame
        .interaction()
        .node(CHANGES_PANE_BUTTON)
        .expect("changes action")
        .bounds();
    let changes_point = Point::new(
        changes_bounds.origin.x + changes_bounds.size.width * 0.5,
        changes_bounds.origin.y + changes_bounds.size.height * 0.5,
    );
    dispatch.pointer_moved(changes_point, frame.interaction());
    dispatch.press_primary(frame.interaction());
    assert!(dispatch.is_pressed(CHANGES_PANE_BUTTON));
    assert_eq!(
        dispatch
            .release_primary(changes_point, frame.interaction())
            .intent,
        Some(UiIntent::Activate(CHANGES_PANE_BUTTON))
    );
}

#[test]
fn expanded_sidebar_updates_the_toggle_icon() {
    let dispatch = UiDispatch::default();
    let titlebar = Titlebar::new(
        Rect::from_xywh(0.0, 0.0, 1000.0, 32.0),
        test_style(),
        true,
        TitlebarInsets::NONE,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::TRANSPARENT);

    frame.draw_component(&titlebar);

    assert_eq!(frame.scene().icons().len(), 3);
    assert_eq!(frame.scene().icons()[0].icon(), icons::LAYOUT_SIDEBAR_LEFT);
    assert_eq!(frame.scene().icons()[1].icon(), icons::DIFF);
    assert_eq!(frame.scene().icons()[2].icon(), icons::GEAR);
    assert!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .all(|text| text.text() != "Settings")
    );
    assert_eq!(
        frame
            .interaction()
            .node(TITLEBAR_SETTINGS_BUTTON)
            .expect("expanded Sidebar exposes the titlebar Settings button")
            .role(),
        zui::ui::AccessibilityRole::Button
    );
}
