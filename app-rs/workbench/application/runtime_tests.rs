use std::collections::BTreeMap;

use super::runtime::GuiConfig;
use super::runtime::gui_editor_text_style;
use super::runtime::gui_interface_typography;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::FontWeight;
use zui::ui::{Color, FontFamily};

#[test]
fn gui_config_builds_the_editor_text_style_without_theme_typography_defaults() {
    let gui = GuiConfig {
        theme: "ash-dark".into(),
        interface_font_family: "Inter".into(),
        interface_font_size: 15,
        editor_font_family: "JetBrains Mono".into(),
        editor_font_size: 15,
        editor_line_height: 24,
    };

    let style = gui_editor_text_style(&gui, Color::WHITE);

    assert_eq!(style.family(), &FontFamily::Named("JetBrains Mono".into()));
    assert_eq!(style.font_size(), 15.0);
    assert_eq!(style.line_height(), 24.0);
    assert_eq!(style.color(), Color::WHITE);
}

#[test]
fn gui_config_maps_semantic_font_families() {
    for (configured, expected) in [
        ("monospace", FontFamily::Monospace),
        ("sans-serif", FontFamily::SansSerif),
        ("serif", FontFamily::Serif),
    ] {
        let style = gui_editor_text_style(
            &GuiConfig {
                theme: "system".into(),
                interface_font_family: "sans-serif".into(),
                interface_font_size: 13,
                editor_font_family: configured.into(),
                editor_font_size: 13,
                editor_line_height: 20,
            },
            Color::WHITE,
        );
        assert_eq!(style.family(), &expected);
    }
}

#[test]
fn gui_config_resolves_interface_family_size_and_semantic_weight() {
    let gui = GuiConfig {
        theme: "system".into(),
        interface_font_family: "Inter".into(),
        interface_font_size: 15,
        editor_font_family: "monospace".into(),
        editor_font_size: 13,
        editor_line_height: 20,
    };

    let typography = gui_interface_typography(&gui, DEFAULT_UI_THEME);

    let body = typography.body_text(Color::WHITE);
    assert_eq!(body.family(), &FontFamily::Named("Inter".into()));
    assert_eq!(body.font_size(), 15.0);
    assert_eq!(body.weight(), FontWeight::Normal);
    let control = typography.control_text(Color::WHITE);
    assert_eq!(control.family(), body.family());
    assert_eq!(control.font_size(), 15.0);
    assert_eq!(control.weight(), FontWeight::Medium);
}

#[test]
fn gui_config_validates_interface_font_preferences() {
    let section = FrontendConfigDto(BTreeMap::from([
        ("interfaceFontFamily".into(), serde_json::json!("Inter")),
        ("interfaceFontSize".into(), serde_json::json!(15)),
        ("futureOption".into(), serde_json::json!(true)),
    ]));

    let config = GuiConfig::from_section(&section).unwrap();

    assert_eq!(config.interface_font_family, "Inter");
    assert_eq!(config.interface_font_size, 15);

    let invalid = FrontendConfigDto(BTreeMap::from([(
        "interfaceFontSize".into(),
        serde_json::json!(5),
    )]));
    assert_eq!(
        GuiConfig::from_section(&invalid).unwrap_err(),
        "gui.interfaceFontSize must be an integer from 6 through 96"
    );
}
