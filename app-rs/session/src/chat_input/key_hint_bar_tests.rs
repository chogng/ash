use super::KeyHintBar;
use crate::SessionPaneStyle;
use crate::interaction::COMPOSER_KEY_HINT_BAR;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::Color;
use zui::ui::InteractionFrame;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::super::ComposerRoute;

#[test]
fn history_status_is_both_visible_and_exposed_to_accessibility() {
    let style = SessionPaneStyle::from_theme(DEFAULT_UI_THEME);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    let status = "History search: fix · No match · Esc cancel";
    frame.draw_component(
        &KeyHintBar::new(
            Rect::from_xywh(10.0, 20.0, 500.0, 24.0),
            ComposerRoute::Agent,
            style,
        )
        .with_history_status(Some(status)),
    );
    assert_eq!(frame.scene().text_blocks()[0].text(), status);
    let nodes = frame
        .interaction()
        .accessibility_nodes(&UiDispatch::default());
    assert!(nodes.iter().any(|node| node.label == status));
}

#[test]
fn key_hint_bar_paints_agent_and_shell_hints_with_dark_keycaps() {
    let style = SessionPaneStyle::from_theme(DEFAULT_UI_THEME);
    let bounds = Rect::from_xywh(10.0, 20.0, 400.0, 24.0);

    for (route, keys, label, accessibility_label) in [
        (
            ComposerRoute::Agent,
            &["/"][..],
            "commands · Ctrl+R history",
            "/ for commands, Up and Down to recall inputs, Control R to search history",
        ),
        (
            ComposerRoute::Shell,
            &["↑", "↓"][..],
            "history · Ctrl+R search",
            "Up and Down for input history, Control R to search history",
        ),
    ] {
        let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

        frame.draw_component(&KeyHintBar::new(bounds, route, style));
        let scene = frame.scene();

        assert_eq!(scene.rects().len(), keys.len());
        assert_eq!(scene.rects()[0].bounds().origin.x, bounds.origin.x);
        for keycap in scene.rects() {
            assert_eq!(keycap.bounds().size.width, 16.0);
            assert_eq!(keycap.bounds().size.height, 16.0);
            assert_eq!(keycap.fill(), style.key_hint_background);
        }
        for key in keys {
            let keycap_label = scene
                .text_blocks()
                .iter()
                .find(|text| text.text() == *key)
                .unwrap();
            assert_eq!(keycap_label.style().color(), style.key_hint_foreground);
        }
        assert!(scene.text_blocks().iter().any(|text| text.text() == label));
        assert!(
            !scene
                .text_blocks()
                .iter()
                .any(|text| text.text() == accessibility_label)
        );
        let accessibility_nodes = frame
            .interaction()
            .accessibility_nodes(&UiDispatch::default());
        assert_eq!(
            accessibility_nodes
                .iter()
                .find(|node| node.id == COMPOSER_KEY_HINT_BAR)
                .unwrap()
                .label,
            accessibility_label
        );
        let inspected_label = scene
            .inspection()
            .target_at(Point::new(bounds.origin.x + 100.0, bounds.origin.y + 12.0))
            .expect("the full key hint bar should be inspectable outside its keycap");
        assert_eq!(inspected_label.name(), "KeyHintBar");
    }
}

#[test]
fn key_hint_bar_uses_appearance_colors() {
    let mut theme = DEFAULT_UI_THEME;
    theme.key_hint_background = Color::rgb(18, 32, 48);
    theme.key_hint_foreground = Color::rgb(224, 232, 240);
    let style = SessionPaneStyle::from_theme(theme);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&KeyHintBar::new(
        Rect::from_xywh(10.0, 20.0, 400.0, 24.0),
        ComposerRoute::Agent,
        style,
    ));

    assert_eq!(frame.scene().rects()[0].fill(), style.key_hint_background);
    let slash = frame
        .scene()
        .text_blocks()
        .iter()
        .find(|text| text.text() == "/")
        .unwrap();
    assert_eq!(slash.style().color(), style.key_hint_foreground);
}
