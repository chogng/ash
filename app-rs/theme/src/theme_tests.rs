use std::fs;

use serde::Deserialize;

use crate::ColorScheme;
use crate::Rgba;
use crate::ThemeCatalog;
use crate::ThemeDocument;
use crate::ThemeLoadOptions;
use crate::ThemeLoader;
use crate::ThemeSizeUnit;
use crate::tokens;

#[test]
fn device_preferences_use_ash_home_unless_explicitly_overridden() {
    const EXPECTED: &str = "ASH_THEME_TEST_EXPECTED_ROOT";
    if let Some(expected) = std::env::var_os(EXPECTED) {
        let actual = crate::default_device_root();
        if expected.is_empty() {
            assert!(actual.is_err());
        } else if expected == "system-home" {
            assert_eq!(
                actual.unwrap(),
                ash_utils_home_dir::find_ash_home().unwrap()
            );
        } else {
            assert_eq!(actual.unwrap(), std::path::PathBuf::from(expected));
        }
        return;
    }
    let root = std::env::temp_dir().join(format!("ash-theme-home-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let root = ash_utils_home_dir::resolve_path(&root).unwrap();
    let selected = root.join("selected");
    let device = root.join("device");
    for (configured, override_root, expected) in [
        (None, None, "system-home".into()),
        (Some(selected.as_path()), None, selected.clone()),
        (
            Some(selected.as_path()),
            Some(device.as_path()),
            device.clone(),
        ),
        (
            Some(selected.as_path()),
            Some(std::path::Path::new("relative")),
            "".into(),
        ),
    ] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "tests::device_preferences_use_ash_home_unless_explicitly_overridden",
            ])
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .env(EXPECTED, expected)
            .env_remove("ASH_HOME")
            .env_remove("ASH_DEVICE_ROOT")
            .env_remove("ASH_PROFILE_ROOT");
        if let Some(path) = configured {
            child.env("ASH_HOME", path);
        }
        if let Some(path) = override_root {
            child.env("ASH_DEVICE_ROOT", path);
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fs::remove_dir(root).unwrap();
}

#[test]
fn embedded_catalog_preserves_aliases_when_a_dependency_is_overridden() {
    let catalog = ThemeCatalog::embedded().unwrap();
    let document = ThemeDocument::parse(
        r##"{
            "version": 1,
            "id": "alias-test",
            "label": "Alias Test",
            "colorScheme": "dark",
            "colors": { "sideBar.background": "#123456" }
        }"##,
    )
    .unwrap();

    let snapshot = catalog.resolve_document(&document).unwrap();

    assert_eq!(
        snapshot.required_color("panel.background").unwrap(),
        Rgba::rgb(18, 52, 86)
    );
}

#[test]
fn embedded_entries_preserve_rust_gui_defaults() {
    let catalog = ThemeCatalog::embedded().unwrap();
    let ash = catalog.built_in_entry("ash", ColorScheme::Light).unwrap();
    let app = catalog.built_in_entry("app", ColorScheme::Light).unwrap();

    assert_eq!(ash.id(), "ash-light");
    assert_eq!(app.id(), "app-light");
    assert_eq!(
        ash.colors().keys().collect::<Vec<_>>(),
        app.colors().keys().collect::<Vec<_>>()
    );
    assert_eq!(
        ash.required_color(tokens::LIST_ACTIVE_SELECTION_BACKGROUND)
            .unwrap(),
        Rgba::rgb(0, 96, 192)
    );
    assert_eq!(
        app.required_color(tokens::LIST_ACTIVE_SELECTION_BACKGROUND)
            .unwrap(),
        Rgba::rgb(235, 235, 237)
    );
    assert_eq!(
        app.required_color("list.activeSelectionForeground")
            .unwrap(),
        app.required_color(tokens::FOREGROUND).unwrap()
    );
}

#[test]
fn embedded_snapshots_expose_typed_size_tokens() {
    let snapshot = ThemeCatalog::embedded()
        .unwrap()
        .built_in(ColorScheme::Light)
        .unwrap();

    let body = snapshot.size(tokens::FONT_SIZE_BODY1).unwrap();
    assert_eq!(body.unit(), ThemeSizeUnit::Pixels);
    assert_eq!(body.value(), 13.0);
    assert_eq!(
        snapshot
            .required_pixel_size(tokens::FONT_SIZE_LABEL1)
            .unwrap(),
        12.0
    );
    assert_eq!(
        snapshot
            .required_size(tokens::FONT_WEIGHT_SEMI_BOLD)
            .unwrap()
            .unit(),
        ThemeSizeUnit::Unitless
    );
    assert_eq!(
        snapshot
            .required_size(tokens::FONT_WEIGHT_MEDIUM)
            .unwrap()
            .as_unitless(),
        Some(500.0)
    );
    assert_eq!(
        snapshot
            .required_size("animation.durationFast")
            .unwrap()
            .as_milliseconds(),
        Some(120.0)
    );
    assert_eq!(
        snapshot
            .required_pixel_size(tokens::SCROLLBAR_SIZE)
            .unwrap(),
        10.0
    );
    assert!(
        snapshot
            .required_pixel_size(tokens::FONT_WEIGHT_SEMI_BOLD)
            .is_err()
    );
}

#[test]
fn loader_uses_the_host_entry_when_device_preference_follows_system() {
    let root = std::env::temp_dir().join(format!("ash-theme-entry-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();

    let loaded = ThemeLoader::embedded()
        .unwrap()
        .preview(
            ThemeLoadOptions::new(&root, ColorScheme::Light).with_default_entry("app"),
            "system",
        )
        .unwrap();

    assert_eq!(loaded.snapshot.id(), "app-light");
    assert!(loaded.follows_system);
    assert!(loaded.diagnostics.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn user_theme_resolves_transforms_and_legacy_editor_tokens() {
    let catalog = ThemeCatalog::embedded().unwrap();
    let document = ThemeDocument::parse(
        r##"{
            "$schema": "https://ash.dev/schemas/app/color-theme.schema.json",
            "version": 1,
            "id": "transform-test",
            "label": "Transform Test",
            "colorScheme": "dark",
            "colors": {
                "toolbar.hoverBackground": { "op": "transparent", "value": "#ffffff", "factor": 0.2 },
                "editor.semanticToken.functionForeground": "#ff8800"
            }
        }"##,
    )
    .unwrap();

    let snapshot = catalog.resolve_document(&document).unwrap();

    assert_eq!(
        snapshot
            .required_color("toolbar.hoverBackground")
            .unwrap()
            .to_string(),
        "#ffffff33"
    );
    assert_eq!(
        snapshot
            .required_color(tokens::EDITOR_TOKEN_FUNCTION)
            .unwrap(),
        Rgba::rgb(255, 136, 0)
    );
}

#[test]
fn gui_theme_uses_explicit_preference_and_isolates_broken_files() {
    let root = std::env::temp_dir().join(format!("ash-theme-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("app/themes")).unwrap();
    fs::write(
        root.join("configuration.json"),
        r#"{"version":1,"values":{"workbench.colorTheme":"graphical-test"}}"#,
    )
    .unwrap();
    fs::write(root.join("app/themes/broken.json"), "{").unwrap();
    fs::write(
        root.join("app/themes/graphical-test.json"),
        r##"{"version":1,"id":"graphical-test","label":"Graphical Test","colorScheme":"dark","colors":{"accent.foreground":"#abcdef"}}"##,
    )
    .unwrap();

    let loaded = ThemeLoader::embedded()
        .unwrap()
        .preview(
            ThemeLoadOptions::new(&root, ColorScheme::Dark).with_default_entry("app"),
            "graphical-test",
        )
        .unwrap();

    assert_eq!(loaded.snapshot.id(), "graphical-test");
    assert!(!loaded.follows_system);
    assert_eq!(
        loaded
            .snapshot
            .required_color(tokens::ACCENT_FOREGROUND)
            .unwrap(),
        Rgba::rgb(171, 205, 239)
    );
    assert_eq!(loaded.diagnostics.len(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn theme_preview_resolves_without_persisting_the_candidate() {
    let root = std::env::temp_dir().join(format!("ash-theme-preview-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let loader = ThemeLoader::embedded().unwrap();
    let options = ThemeLoadOptions::new(&root, ColorScheme::Dark).with_default_entry("app");

    let preview = loader.preview(options, "app-light").unwrap();

    assert_eq!(preview.snapshot.id(), "app-light");
    assert!(!root.join("configuration.json").exists());
    assert_eq!(
        loader.preview(options, "system").unwrap().snapshot.id(),
        "app-dark"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unavailable_theme_selection_does_not_rewrite_device_configuration() {
    let root = std::env::temp_dir().join(format!("ash-theme-unavailable-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let configuration = r#"{"version":1,"values":{"workbench.colorTheme":"ash-light"}}"#;
    fs::write(root.join("configuration.json"), configuration).unwrap();

    let error = ThemeLoader::embedded()
        .unwrap()
        .preview(
            ThemeLoadOptions::new(&root, ColorScheme::Dark),
            "missing-theme",
        )
        .unwrap_err();

    assert_eq!(error.to_string(), "theme 'missing-theme' is unavailable");
    assert_eq!(
        fs::read_to_string(root.join("configuration.json")).unwrap(),
        configuration
    );
    fs::remove_dir_all(root).unwrap();
}

#[derive(Deserialize)]
struct ConformanceFixture {
    theme: serde_json::Value,
    expected: std::collections::BTreeMap<String, String>,
}

#[test]
fn rust_resolver_preserves_alias_and_transform_results() {
    let fixture: ConformanceFixture =
        serde_json::from_str(include_str!("fixtures/resolver.json")).unwrap();
    let document = ThemeDocument::parse(&fixture.theme.to_string()).unwrap();
    let snapshot = ThemeCatalog::embedded()
        .unwrap()
        .resolve_document(&document)
        .unwrap();

    for (token, expected) in fixture.expected {
        assert_eq!(
            snapshot.required_color(&token).unwrap().to_string(),
            expected,
            "{token}"
        );
    }
}

#[test]
fn user_theme_document_rejects_invalid_color_values() {
    for source in [
        r#"{"version":1,"id":"invalid","label":"Invalid","colorScheme":"dark","colors":{"foreground":null}}"#,
        r#"{"version":1,"id":"invalid","label":"Invalid","colorScheme":"dark","colors":{"foreground":"not a token"}}"#,
        r##"{"version":1,"id":"invalid","label":"Invalid","colorScheme":"dark","colors":{"foreground":{"op":"transparent","value":"#fff","factor":2}}}"##,
    ] {
        assert!(ThemeDocument::parse(source).is_err(), "{source}");
    }
}

#[test]
fn rust_gui_owns_its_theme_template_and_schema() {
    let source = include_str!("../resources/color-theme.template.json");
    let document = ThemeDocument::parse(source).unwrap();
    let snapshot = ThemeCatalog::embedded()
        .unwrap()
        .resolve_document(&document)
        .unwrap();
    assert_eq!(snapshot.id(), "my-custom-theme");
    let desktop = source.replace(
        "https://ash.dev/schemas/app/color-theme.schema.json",
        "https://ash.dev/schemas/color-theme.schema.json",
    );
    assert!(matches!(
        ThemeDocument::parse(&desktop),
        Err(crate::ThemeError::InvalidSchema)
    ));
}

#[test]
fn rust_gui_does_not_discover_desktop_themes_or_change_desktop_settings() {
    let root = std::env::temp_dir().join(format!("ash-theme-isolation-{}", std::process::id()));
    fs::create_dir_all(root.join("themes")).unwrap();
    let source = include_str!("../resources/color-theme.template.json");
    let configuration = r#"{"version":1,"values":{"workbench.colorTheme":"my-custom-theme"}}"#;
    fs::write(root.join("themes/custom.json"), source).unwrap();
    fs::write(root.join("configuration.json"), configuration).unwrap();
    let loader = ThemeLoader::embedded().unwrap();
    let options = ThemeLoadOptions::new(&root, ColorScheme::Dark).with_default_entry("app");

    assert!(matches!(
        loader.preview(options, "my-custom-theme"),
        Err(crate::ThemeSelectionError::Unavailable(_))
    ));
    assert_eq!(
        loader.preview(options, "system").unwrap().snapshot.id(),
        "app-dark"
    );
    fs::create_dir_all(root.join("app/themes")).unwrap();
    fs::write(root.join("app/themes/custom.json"), source).unwrap();
    let loaded = loader.preview(options, "my-custom-theme").unwrap();
    let style = crate::UiTheme::from_snapshot(&loaded.snapshot).unwrap();
    assert_eq!(loaded.snapshot.id(), "my-custom-theme");
    assert_eq!(style.workbench_background, zui::ui::Color::rgb(11, 16, 32));
    assert_eq!(style.editor_foreground, zui::ui::Color::rgb(219, 231, 255));
    assert_eq!(
        fs::read_to_string(root.join("configuration.json")).unwrap(),
        configuration
    );
    assert_eq!(
        fs::read_to_string(root.join("themes/custom.json")).unwrap(),
        source
    );
    fs::remove_dir_all(root).unwrap();
}
