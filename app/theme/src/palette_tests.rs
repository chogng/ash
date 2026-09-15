use super::UiTheme;
use ash_theme::ColorScheme;
use ash_theme::ThemeCatalog;
use ash_theme::ThemeDocument;
use zui::ui::Color;
use zui::ui::FontFamily;
use zui::ui::FontWeight;

#[test]
fn snapshot_projection_resolves_layout_component_tokens_and_standard_sizes() {
    let snapshot = ThemeCatalog::embedded()
        .unwrap()
        .built_in(ColorScheme::Light)
        .unwrap();
    let theme = UiTheme::from_snapshot(&snapshot).unwrap();

    assert_eq!(theme.font_size_body, 13.0);
    assert_eq!(theme.font_size_label, 12.0);
    let editor_text = theme.editor_text.text_style(Color::WHITE);
    assert_eq!(editor_text.font_size(), 13.0);
    assert_eq!(editor_text.line_height(), 20.0);
    assert_eq!(editor_text.weight(), FontWeight::Normal);
    let editor_header = theme.editor_header.text_style(Color::WHITE);
    assert_eq!(editor_header.font_size(), 12.0);
    assert_eq!(editor_header.line_height(), 32.0);
    assert_eq!(editor_header.weight(), FontWeight::Bold);
    let compact_action_label = theme.compact_action_label.text_style(Color::WHITE);
    assert_eq!(compact_action_label.font_size(), 12.0);
    assert_eq!(compact_action_label.line_height(), 16.0);
    assert_eq!(compact_action_label.weight(), FontWeight::SemiBold);
    let typography =
        super::UiTypography::from_theme(theme, FontFamily::Named("Inter".into()), 15.0);
    let body = typography.body_text(Color::WHITE);
    assert_eq!(body.family(), &FontFamily::Named("Inter".into()));
    assert_eq!(body.font_size(), 15.0);
    assert_eq!(body.weight(), FontWeight::Normal);
    let control = typography.control_text(Color::WHITE);
    assert_eq!(control.font_size(), 15.0);
    assert_eq!(control.weight(), FontWeight::Medium);
    let heading = typography.heading_text(Color::WHITE);
    assert!((heading.font_size() - 18.0 * (15.0 / 13.0)).abs() < f32::EPSILON);
    assert_eq!(heading.weight(), FontWeight::SemiBold);
    assert_eq!(theme.scrollbar_size, 10.0);
    assert_eq!(theme.hover_foreground, Color::rgb(245, 245, 247));
    assert_eq!(theme.hover_background, Color::rgb(45, 46, 51));
    assert_eq!(theme.hover_border, Color::rgba(255, 255, 255, 24));
    assert_eq!(theme.hover_shadow, Color::rgba(0, 0, 0, 48));
    assert_eq!(theme.menu_foreground, Color::rgb(0, 0, 0));
    assert_eq!(theme.menu_hover_background, Color::rgb(226, 226, 228));
    assert_eq!(theme.action_bar_background, Color::rgb(245, 245, 246));
    assert_eq!(theme.key_hint_foreground, Color::rgb(85, 85, 85));
    assert_eq!(theme.key_hint_background, Color::rgba(221, 221, 221, 102));
    assert_eq!(theme.tab_hover_background, Color::rgb(226, 226, 228));
    assert_eq!(theme.editor_foreground, Color::rgb(51, 51, 51));
    assert_eq!(theme.editor_syntax.comment, Color::rgb(0, 128, 0));
}

#[test]
fn appearance_overrides_key_hint_colors_through_keybinding_label_tokens() {
    let document = ThemeDocument::parse(
        r##"{
            "$schema": "https://ash.dev/schemas/app/color-theme.schema.json",
            "version": 1,
            "id": "key-hint-test",
            "label": "Key Hint Test",
            "colorScheme": "dark",
            "colors": {
                "keybindingLabel.background": "#122030",
                "keybindingLabel.foreground": "#e0e8f0"
            }
        }"##,
    )
    .unwrap();
    let snapshot = ThemeCatalog::embedded()
        .unwrap()
        .resolve_document(&document)
        .unwrap();
    let theme = UiTheme::from_snapshot(&snapshot).unwrap();

    assert_eq!(theme.key_hint_background, Color::rgb(18, 32, 48));
    assert_eq!(theme.key_hint_foreground, Color::rgb(224, 232, 240));
}
