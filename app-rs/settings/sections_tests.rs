use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollDelta;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use ash_ui_components::ScrollViewStyle;
use ash_ui_components::ScrollbarPresentation;
use ash_ui_components::ScrollbarStyle;
use zui::ui::Color;
use zui::ui::InteractionFrame;
use zui::ui::Rect;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::SettingsSectionPane;
use super::SettingsSectionStyle;
use crate::SETTINGS_KEYBINDINGS_LIST;
use crate::SETTINGS_KEYBINDINGS_SCROLLBAR;
use crate::SettingsKeybindingRow;
use crate::SettingsPageSection;
use zui::ui::Size;

fn style() -> SettingsSectionStyle {
    let text = Color::rgb(38, 38, 41);
    let text_muted = Color::rgb(126, 126, 132);
    SettingsSectionStyle {
        background: Color::WHITE,
        surface: Color::rgb(246, 246, 247),
        surface_raised: Color::rgb(248, 248, 249),
        surface_hovered: Color::rgb(235, 235, 237),
        border: Color::rgb(222, 222, 224),
        text,
        text_muted,
        accent: Color::rgb(15, 110, 96),
        error: Color::rgb(180, 38, 38),
        scroll_view: ScrollViewStyle::new(ScrollbarStyle::new(Color::TRANSPARENT, text_muted)),
        heading_text: TextStyle::new(18.0, text).with_line_height(24.0),
        body_text: TextStyle::new(13.0, text).with_line_height(18.0),
        control_text: TextStyle::new(13.0, text).with_line_height(18.0),
        label_text: TextStyle::new(12.0, text_muted).with_line_height(18.0),
    }
}

#[test]
fn keybindings_section_composes_scroll_view_with_translated_visible_rows() {
    let rows = (0..18)
        .map(|index| SettingsKeybindingRow {
            element: zui::ui::ElementId::scoped(90, index + 1),
            label: format!("Command {index}"),
            value: "Unassigned".to_owned(),
        })
        .collect::<Vec<_>>();
    let bounds = Rect::from_xywh(0.0, 0.0, 600.0, 300.0);
    let mut scroll = ScrollState::default();
    scroll.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(100.0)),
        ScrollMetrics::new(bounds.size, Size::new(600.0, 800.0)),
        ScrollAxis::Vertical,
    );
    let dispatch = UiDispatch::default();
    let pane = SettingsSectionPane::new(
        bounds,
        SettingsPageSection::Keybindings,
        style(),
        "ash",
        "Local",
        "Agent",
        &rows,
        false,
        &[],
        "Light",
        true,
        scroll,
        ScrollbarPresentation::default(),
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);

    frame.draw_component(&pane);

    assert!(
        frame
            .scene()
            .inspection()
            .nodes()
            .iter()
            .any(|node| node.name() == "ScrollView")
    );
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .find(|block| block.text() == "Command 3")
            .expect("translated visible row")
            .origin()
            .y,
        140.0,
    );
    assert_eq!(
        frame
            .scene()
            .text_blocks()
            .iter()
            .find(|block| block.text() == "Keybindings")
            .expect("fixed section title")
            .origin()
            .y,
        32.0,
    );
    assert_eq!(
        frame
            .interaction()
            .node(rows[0].element)
            .expect("visible keybinding row")
            .parent(),
        Some(SETTINGS_KEYBINDINGS_LIST),
    );
    assert!(
        frame
            .interaction()
            .node(rows[10].element)
            .expect("offscreen row keeps keyboard identity")
            .bounds()
            .is_empty()
    );
    let scrollbar = frame
        .interaction()
        .node(SETTINGS_KEYBINDINGS_SCROLLBAR)
        .expect("accessible keybindings scrollbar");
    assert_eq!(scrollbar.role(), zui::ui::AccessibilityRole::ScrollBar);
    assert_eq!(scrollbar.parent(), Some(SETTINGS_KEYBINDINGS_LIST));
}
