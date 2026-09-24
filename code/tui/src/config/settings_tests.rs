use super::GlyphSet;
use super::KeyHintStyle;
use super::TerminalSettings;
use crate::nls::Language;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use std::collections::BTreeMap;

#[test]
fn tui_table_defaults_missing_terminal_fields() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "theme".into(),
        serde_json::json!("ash-code-light"),
    )]));

    let settings = TerminalSettings::from_tui(&section).unwrap();

    assert!(!settings.memory_diagnostics());
    assert_eq!(settings.auto_update(), crate::UpdatePolicy::Latest);
    assert_eq!(settings.language(), Language::English);
    assert_eq!(settings.key_hint_style(), KeyHintStyle::Contrast);
    assert_eq!(settings.glyph_set(), GlyphSet::Powerline);
    assert_eq!(
        settings.screen_mode(),
        crate::terminal::ScreenMode::Fullscreen
    );
}

#[test]
fn glyph_set_round_trips_and_rejects_unknown_values() {
    for (value, expected) in [
        ("powerline", GlyphSet::Powerline),
        ("plain", GlyphSet::Plain),
    ] {
        let section = FrontendConfigDto(BTreeMap::from([(
            "glyphSet".into(),
            serde_json::json!(value),
        )]));
        let settings = TerminalSettings::from_tui(&section).unwrap();
        assert_eq!(settings.glyph_set(), expected);
        assert_eq!(
            settings.write_to_tui(&section).unwrap().0["glyphSet"],
            serde_json::json!(value)
        );
    }
    for value in [serde_json::json!(true), serde_json::json!("auto")] {
        let section = FrontendConfigDto(BTreeMap::from([("glyphSet".into(), value)]));
        assert!(TerminalSettings::from_tui(&section).is_err());
    }
}

#[test]
fn key_hint_style_round_trips_and_rejects_unknown_values() {
    for (value, expected) in [
        ("contrast", KeyHintStyle::Contrast),
        ("muted", KeyHintStyle::Muted),
    ] {
        let section = FrontendConfigDto(BTreeMap::from([(
            "keyHintStyle".into(),
            serde_json::json!(value),
        )]));
        let settings = TerminalSettings::from_tui(&section).unwrap();
        assert_eq!(settings.key_hint_style(), expected);
        assert_eq!(
            settings.write_to_tui(&section).unwrap().0["keyHintStyle"],
            serde_json::json!(value)
        );
    }
    for value in [serde_json::json!(true), serde_json::json!("strong")] {
        let section = FrontendConfigDto(BTreeMap::from([("keyHintStyle".into(), value)]));
        assert!(TerminalSettings::from_tui(&section).is_err());
    }
}

#[test]
fn screen_mode_round_trips_preserves_other_fields_and_rejects_invalid_values() {
    for (name, expected) in [
        ("fullscreen", crate::terminal::ScreenMode::Fullscreen),
        ("inline", crate::terminal::ScreenMode::Inline),
    ] {
        let section = FrontendConfigDto(BTreeMap::from([
            ("screenMode".into(), serde_json::json!(name)),
            ("futureOption".into(), serde_json::json!({"enabled": true})),
        ]));
        let settings = TerminalSettings::from_tui(&section).unwrap();
        assert_eq!(settings.screen_mode(), expected);
        let updated = settings.write_to_tui(&section).unwrap();
        assert_eq!(updated.0["screenMode"], serde_json::json!(name));
        assert_eq!(updated.0["futureOption"], section.0["futureOption"]);
    }
    for value in [
        serde_json::json!("auto"),
        serde_json::json!("native"),
        serde_json::json!("Fullscreen"),
        serde_json::json!("Inline"),
        serde_json::json!(true),
        serde_json::Value::Null,
    ] {
        assert!(
            TerminalSettings::from_tui(&FrontendConfigDto(BTreeMap::from([(
                "screenMode".into(),
                value
            )])))
            .is_err()
        );
    }
}

#[test]
fn terminal_settings_update_removes_legacy_fields() {
    let section = FrontendConfigDto(BTreeMap::from([
        (
            "dirPermissions".into(),
            serde_json::json!({"readFiles": true, "writeFiles": true}),
        ),
        ("followUpMode".into(), serde_json::json!("steer")),
    ]));

    let settings = TerminalSettings::from_tui(&section).unwrap();
    let updated = settings.write_to_tui(&section).unwrap();

    assert!(!updated.0.contains_key("dirPermissions"));
    assert!(!updated.0.contains_key("followUpMode"));
}

#[test]
fn automatic_update_policy_round_trips_and_rejects_unknown_values() {
    for (value, expected) in [
        ("latest", crate::UpdatePolicy::Latest),
        ("stable", crate::UpdatePolicy::Stable),
        ("never", crate::UpdatePolicy::Never),
    ] {
        let section = FrontendConfigDto(BTreeMap::from([(
            "autoUpdate".into(),
            serde_json::json!(value),
        )]));
        let settings = TerminalSettings::from_tui(&section).unwrap();
        assert_eq!(settings.auto_update(), expected);
        assert_eq!(
            settings.write_to_tui(&section).unwrap().0["autoUpdate"],
            serde_json::json!(value)
        );
    }
    let section = FrontendConfigDto(BTreeMap::from([(
        "autoUpdate".into(),
        serde_json::json!(true),
    )]));
    assert!(TerminalSettings::from_tui(&section).is_err());
}

#[test]
fn terminal_settings_update_preserves_other_tui_fields() {
    let section = FrontendConfigDto(BTreeMap::from([
        ("theme".into(), serde_json::json!("ash-code-light")),
        ("futureOption".into(), serde_json::json!({"enabled": true})),
    ]));
    let mut settings = TerminalSettings::default();
    settings.set_memory_diagnostics(true);
    settings.set_auto_update(crate::UpdatePolicy::Never);
    settings.set_language(Language::French);
    settings.set_key_hint_style(KeyHintStyle::Muted);

    let updated = settings.write_to_tui(&section).unwrap();

    assert_eq!(updated.0["theme"], serde_json::json!("ash-code-light"));
    assert_eq!(
        updated.0["futureOption"],
        serde_json::json!({"enabled": true})
    );
    assert_eq!(updated.0["memoryDiagnostics"], serde_json::json!(true));
    assert_eq!(updated.0["autoUpdate"], serde_json::json!("never"));
    assert_eq!(updated.0["language"], serde_json::json!("fr"));
    assert_eq!(updated.0["keyHintStyle"], serde_json::json!("muted"));
}

#[test]
fn invalid_terminal_values_are_rejected_by_the_tui() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "inputMode".into(),
        serde_json::json!("emacs"),
    )]));

    assert!(TerminalSettings::from_tui(&section).is_err());
}

#[test]
fn supported_languages_round_trip_from_the_tui_table() {
    for (value, expected) in [
        ("en", Language::English),
        ("ja", Language::Japanese),
        ("zh-CN", Language::Chinese),
        ("fr", Language::French),
    ] {
        let section = FrontendConfigDto(BTreeMap::from([(
            "language".into(),
            serde_json::json!(value),
        )]));

        let settings = TerminalSettings::from_tui(&section).unwrap();

        assert_eq!(settings.language(), expected);
        assert_eq!(
            settings.write_to_tui(&section).unwrap().0["language"],
            serde_json::json!(value)
        );
    }
}

#[test]
fn unsupported_language_is_rejected() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "language".into(),
        serde_json::json!("de"),
    )]));

    assert!(TerminalSettings::from_tui(&section).is_err());
}

#[test]
fn obsolete_pointer_settings_do_not_affect_screen_mode_and_are_removed_on_write() {
    for mode in ["fullscreen", "inline"] {
        for old in [
            serde_json::json!(false),
            serde_json::json!(true),
            serde_json::json!("obsolete"),
        ] {
            let section = FrontendConfigDto(BTreeMap::from([
                ("screenMode".into(), serde_json::json!(mode)),
                ("mouseInteractions".into(), old.clone()),
                ("copyOnSelect".into(), old),
                ("theme".into(), serde_json::json!("graphite")),
                ("futureOption".into(), serde_json::json!({"enabled": true})),
            ]));
            let settings = TerminalSettings::from_tui(&section).unwrap();
            assert_eq!(settings.screen_mode().label(), mode);
            let updated = settings.write_to_tui(&section).unwrap();
            assert!(!updated.0.contains_key("mouseInteractions"));
            assert!(!updated.0.contains_key("copyOnSelect"));
            assert_eq!(updated.0["theme"], section.0["theme"]);
            assert_eq!(updated.0["futureOption"], section.0["futureOption"]);
            assert_eq!(settings.write_to_tui(&updated).unwrap(), updated);
        }
    }
}
