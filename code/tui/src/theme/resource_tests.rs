use std::fs;

use ash_terminal_detection::ColorLevel;
use ash_terminal_detection::TerminalRgb;
use ratatui::style::Color;

use super::ThemeAppearance;
use super::ThemeResource;

#[test]
fn catalog_and_resolution_use_the_supplied_config_preference() {
    let root = std::env::temp_dir().join(format!("ash-tui-theme-command-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let resource =
        ThemeResource::for_test(root.clone(), ColorLevel::TrueColor, ThemeAppearance::Dark);

    let catalog = resource.catalog("system").unwrap();
    assert_eq!(catalog.choices.len(), 8);
    assert_eq!(catalog.choices[0].label, "Auto (match terminal)");
    assert_eq!(catalog.choices[0].palette_label, "GitHub Dark");
    assert!(catalog.choices[0].selected);
    assert_eq!(catalog.choices[7].label, "Custom color theme");
    assert_eq!(catalog.choices[3].palette_label, "GitHub Dark Colorblind");
    assert_eq!(
        catalog.choices[5].palette_label,
        "GitHub Dark · ANSI 16 colors"
    );

    let selection = resource.resolve("ash-code-dark").unwrap();
    assert_eq!(selection.theme.background(), Color::Rgb(13, 17, 23));
    assert!(resource.catalog("ash-code-dark").unwrap().choices[1].selected);
    assert!(resource.resolve("ash-dark").is_err());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn ansi_modes_force_ansi_16_colors() {
    let root = std::env::temp_dir().join(format!("ash-tui-ansi-theme-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let resource =
        ThemeResource::for_test(root.clone(), ColorLevel::TrueColor, ThemeAppearance::Dark);

    let ansi = resource.catalog("system").unwrap().choices[5].palette;
    assert!(!matches!(ansi.keyword, Color::Rgb(..) | Color::Indexed(..)));
    assert!(!matches!(
        ansi.inserted_marker,
        Color::Rgb(..) | Color::Indexed(..)
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn auto_uses_the_terminal_reported_background_scheme() {
    assert_eq!(
        super::detect_system_appearance(Some(TerminalRgb::new(245, 245, 245))),
        ThemeAppearance::Light
    );
    assert_eq!(
        super::detect_system_appearance(Some(TerminalRgb::new(13, 17, 23))),
        ThemeAppearance::Dark
    );

    let root = std::env::temp_dir().join(format!("ash-tui-auto-theme-{}", std::process::id()));
    let light =
        ThemeResource::for_test(root.clone(), ColorLevel::TrueColor, ThemeAppearance::Light)
            .load("system")
            .unwrap()
            .theme;
    let dark = ThemeResource::for_test(root, ColorLevel::TrueColor, ThemeAppearance::Dark)
        .load("system")
        .unwrap()
        .theme;

    assert_eq!(light.background(), Color::Reset);
    assert_eq!(light.foreground(), Color::Reset);
    assert_eq!(light.action_foreground(), Color::Rgb(9, 105, 218));
    assert_eq!(dark.background(), Color::Reset);
    assert_eq!(dark.foreground(), Color::Reset);
    assert_eq!(dark.action_foreground(), Color::Rgb(88, 166, 255));
}

#[test]
fn custom_themes_are_read_only_from_the_ash_code_theme_directory() {
    let profile_root =
        std::env::temp_dir().join(format!("ash-tui-custom-theme-{}", std::process::id()));
    let product_root = profile_root.join("ash-code");
    let _ = fs::remove_dir_all(&profile_root);
    fs::create_dir_all(product_root.join("themes")).unwrap();
    fs::write(
        product_root.join("themes/graphite.json"),
        r##"{
  "schemaVersion": 2,
  "id": "graphite",
  "label": "Graphite",
  "appearance": "dark",
  "colors": {
    "background": "#101010",
    "focus": "#112233",
    "actionForeground": "#334477",
    "hoverBackground": "#223344",
    "modalBorder": "#556677",
    "pressedForeground": "#334455",
    "selectionBackground": "#445566",
    "transcriptJumpBackground": "#414141",
    "userMessageBackground": "#252525",
    "quickViewBackground": "#303030",
    "screenSelectionBackground": "#80cfff",
    "screenSelectionForeground": "#101820"
  }
}"##,
    )
    .unwrap();
    fs::write(
        profile_root.join("configuration.json"),
        r#"{"version":1,"values":{"workbench.colorTheme":"desktop-theme"}}"#,
    )
    .unwrap();
    let resource =
        ThemeResource::for_test(product_root, ColorLevel::TrueColor, ThemeAppearance::Dark);

    let catalog = resource.catalog("system").unwrap();
    assert!(catalog.choices[0].selected);
    assert_eq!(catalog.custom_choices.len(), 1);
    assert_eq!(catalog.custom_choices[0].label, "Graphite");

    let selected = resource.resolve("graphite").unwrap();
    assert_eq!(selected.theme.background(), Color::Rgb(16, 16, 16));
    assert_eq!(selected.theme.focus(), Color::Rgb(17, 34, 51));
    assert_eq!(selected.theme.action_foreground(), Color::Rgb(51, 68, 119));
    assert_eq!(selected.theme.hover_background(), Color::Rgb(34, 51, 68));
    assert_eq!(selected.theme.modal_border(), Color::Rgb(85, 102, 119));
    assert_eq!(selected.theme.pressed_foreground(), Color::Rgb(51, 68, 85));
    assert_eq!(
        selected.theme.selection_background(),
        Color::Rgb(68, 85, 102)
    );
    assert_eq!(selected.theme.overlay_background(), Color::Rgb(48, 48, 48));
    assert_eq!(
        selected.theme.transcript_jump_background(),
        Color::Rgb(65, 65, 65)
    );
    assert_eq!(
        selected.theme.user_message_background(),
        Color::Rgb(37, 37, 37)
    );
    assert_eq!(
        selected.theme.screen_selection_background(),
        Color::Rgb(128, 207, 255)
    );
    assert_eq!(
        selected.theme.screen_selection_foreground(),
        Color::Rgb(16, 24, 32)
    );

    fs::remove_dir_all(profile_root).unwrap();
}

#[test]
fn graphical_theme_tokens_are_rejected_by_the_tui_theme_reader() {
    let product_root = std::env::temp_dir().join(format!(
        "ash-tui-graphical-theme-token-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&product_root);
    fs::create_dir_all(product_root.join("themes")).unwrap();
    fs::write(
        product_root.join("themes/desktop.json"),
        r##"{
  "schemaVersion": 2,
  "id": "desktop",
  "label": "Desktop",
  "appearance": "dark",
  "colors": { "editor.background": "#101010" }
}"##,
    )
    .unwrap();
    let resource = ThemeResource::for_test(
        product_root.clone(),
        ColorLevel::TrueColor,
        ThemeAppearance::Dark,
    );

    let loaded = resource.load("system").unwrap();

    assert_eq!(loaded.theme.background(), Color::Reset);
    assert!(
        loaded
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("unknown TUI theme color 'editor.background'"))
    );
    fs::remove_dir_all(product_root).unwrap();
}

#[test]
fn loading_and_switching_the_auto_theme_preserve_the_reported_background_for_fades() {
    let root = tempfile::tempdir().unwrap();
    let mut resource = ThemeResource::for_test(
        root.path().into(),
        ColorLevel::TrueColor,
        ThemeAppearance::Dark,
    );
    resource.terminal_background = Some(TerminalRgb::new(1, 2, 3));
    let expected = crate::render::RenderTheme::from_palette(
        crate::render::ThemePalette::dark(),
        ColorLevel::TrueColor,
    )
    .with_terminal_defaults()
    .with_terminal_background([1, 2, 3]);
    assert_eq!(resource.load("system").unwrap().theme, expected);
    assert_eq!(resource.resolve("system").unwrap().theme, expected);
}
