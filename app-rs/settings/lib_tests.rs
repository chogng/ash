use ash_icons::icons;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use ash_ui_components::InteractionRegion;
use ash_ui_components::SearchBoxStyle;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::FontFamily;
use zui::ui::FontWeight;
use zui::ui::InteractionFrame;
use zui::ui::NodeAction;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::{
    SETTINGS_CLOSE, SETTINGS_NAV_APPEARANCE, SETTINGS_NAV_GENERAL, SETTINGS_NAV_KEYBINDINGS,
    SETTINGS_NAV_REMOTE, SETTINGS_PAGE, SETTINGS_SEARCH_INPUT, SettingsPage, SettingsPageLayout,
    SettingsPageSection, SettingsPageStyle,
};

fn style() -> SettingsPageStyle {
    let border = Color::rgb(222, 222, 224);
    let text = Color::rgb(38, 38, 41);
    let text_muted = Color::rgb(126, 126, 132);
    let input = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::WHITE, Color::WHITE),
        InputBoxStateColors::new(border, border, Color::rgb(15, 110, 96)),
        TextStyle::new(13.0, text).with_line_height(18.0),
        TextStyle::new(13.0, text_muted).with_line_height(18.0),
    );
    let nav = ButtonStyle::new(
        ButtonBackgrounds::new(Color::TRANSPARENT),
        TextStyle::new(13.0, text).with_line_height(18.0),
    );
    let close = ButtonStyle::new(
        ButtonBackgrounds::new(Color::TRANSPARENT),
        TextStyle::new(13.0, text).with_line_height(18.0),
    );
    SettingsPageStyle::new(
        Color::rgb(252, 252, 253),
        Color::rgb(246, 246, 247),
        border,
        TextStyle::new(12.0, text_muted).with_line_height(18.0),
        SearchBoxStyle::new(input, icons::SEARCH, text_muted),
        nav,
        close,
    )
}

#[test]
fn layout_keeps_rail_header_and_content_separate() {
    let layout =
        SettingsPageLayout::for_viewport(zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0));
    assert!(layout.rail().right() <= layout.content().origin.x);
    assert_eq!(layout.header().size.height, 32.0);
    assert_eq!(layout.header().bottom(), layout.content().origin.y);
    assert!(layout.search().origin.x >= layout.rail().origin.x);
    assert!(layout.search().right() <= layout.rail().right());
    assert!(layout.search().bottom() < layout.navigation_bounds(0).origin.y);
    assert!(layout.close().right() <= layout.header().right());
}

#[test]
fn page_registers_host_boundary_and_sections() {
    let dispatch = UiDispatch::default();
    let input = zui::ui::TextInput::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let page = SettingsPage::new(
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &input,
        CaretVisibility::Visible,
        style(),
        &dispatch,
        &mut text_layout,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(zui::ui::Color::WHITE);
    let parent = zui::ui::ElementId::scoped(1, 1);
    let page = page.with_parent(parent);
    frame.draw_component(&page);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert!(nodes.iter().any(|node| node.id == SETTINGS_PAGE));
    assert!(nodes.iter().any(|node| node.id == SETTINGS_SEARCH_INPUT));
    assert!(nodes.iter().any(|node| node.id == SETTINGS_CLOSE));
    for id in [
        SETTINGS_NAV_GENERAL,
        SETTINGS_NAV_APPEARANCE,
        SETTINGS_NAV_KEYBINDINGS,
        SETTINGS_NAV_REMOTE,
    ] {
        let node = frame.interaction().node(id).expect("section node");
        assert_eq!(node.action(), zui::ui::NodeAction::Activate);
    }
    assert!(
        nodes
            .iter()
            .all(|node| { node.id != SETTINGS_PAGE || node.role == AccessibilityRole::Group })
    );
}

#[test]
fn page_uses_resolved_interface_typography_for_navigation() {
    let dispatch = UiDispatch::default();
    let input = zui::ui::TextInput::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let typography = ash_ui_theme::UiTypography::from_theme(
        ash_ui_theme::DEFAULT_UI_THEME,
        FontFamily::Named("Inter".into()),
        15.0,
    );
    let page = SettingsPage::new(
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &input,
        CaretVisibility::Visible,
        SettingsPageStyle::from_theme(ash_ui_theme::DEFAULT_UI_THEME, &typography),
        &dispatch,
        &mut text_layout,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(zui::ui::Color::WHITE);

    frame.draw_component(&page);

    let general = frame
        .scene()
        .text_blocks()
        .iter()
        .find(|block| block.text() == "General")
        .expect("General navigation label");
    assert_eq!(general.style().family(), &FontFamily::Named("Inter".into()));
    assert_eq!(general.style().font_size(), 15.0);
    assert_eq!(general.style().weight(), FontWeight::Medium);
}

#[test]
fn remote_section_is_projected_to_the_navigation_semantics() {
    let dispatch = UiDispatch::default();
    let input = zui::ui::TextInput::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let page = SettingsPage::new_with_header_height_and_section(
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        32.0,
        &input,
        CaretVisibility::Visible,
        style(),
        SettingsPageSection::Remote,
        &dispatch,
        &mut text_layout,
    );

    let mut frame = UiFrame::<InteractionFrame>::new(zui::ui::Color::WHITE);
    frame.draw_component(&page);

    assert_eq!(
        frame
            .interaction()
            .node(SETTINGS_NAV_REMOTE)
            .expect("Remote navigation node")
            .selection(),
        AccessibilitySelection::Selected
    );
}

#[test]
fn selected_section_is_projected_to_the_navigation_semantics() {
    let dispatch = UiDispatch::default();
    let input = zui::ui::TextInput::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let page = SettingsPage::new_with_header_height_and_section(
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        32.0,
        &input,
        CaretVisibility::Visible,
        style(),
        SettingsPageSection::Appearance,
        &dispatch,
        &mut text_layout,
    );
    assert_eq!(page.section(), SettingsPageSection::Appearance);

    let mut frame = UiFrame::<InteractionFrame>::new(zui::ui::Color::WHITE);
    frame.draw_component(&page);
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == SETTINGS_NAV_APPEARANCE)
            .expect("appearance node")
            .selection,
        AccessibilitySelection::Selected
    );
    assert_eq!(
        nodes
            .iter()
            .find(|node| node.id == SETTINGS_NAV_GENERAL)
            .expect("general node")
            .selection,
        AccessibilitySelection::Unselected
    );
}

#[test]
fn settings_page_does_not_own_dialog_interaction_scope() {
    let dispatch = UiDispatch::default();
    let input = zui::ui::TextInput::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let host_id = ElementId::scoped(1, 1);
    let host = InteractionRegion::new(
        "SettingsHost",
        host_id,
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        AccessibilityRole::Group,
        "Main surface",
    )
    .with_focus(FocusBehavior::TabStop)
    .with_action(NodeAction::Activate);
    let page = SettingsPage::new(
        zui::ui::Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &input,
        CaretVisibility::Visible,
        style(),
        &dispatch,
        &mut text_layout,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(zui::ui::Color::WHITE);
    frame.draw_component(&host);
    frame.draw_component(&page);

    assert!(frame.interaction().focus_order().any(|id| id == host_id));
}
