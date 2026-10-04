use super::DictationShortcutSettings;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn shortcut_is_disabled_by_default_and_matches_only_its_key() {
    let settings = DictationShortcutSettings::default();
    assert!(!settings.enabled);
    assert_eq!(settings.shortcut, "ctrl+g");
    assert!(settings.matches(&KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL,)));
    assert!(!settings.matches(&KeyEvent::new(KeyCode::F(8), KeyModifiers::NONE,)));
}

#[test]
fn invalid_persisted_value_and_multi_key_shortcut_are_rejected() {
    assert!(
        DictationShortcutSettings::from_tui(&BTreeMap::from([(
            "dictationShortcutEnabled".into(),
            json!("true"),
        )]))
        .is_err()
    );
    assert!(
        DictationShortcutSettings::default()
            .with_shortcut("ctrl+k ctrl+g")
            .is_err()
    );
    assert!(
        DictationShortcutSettings::default()
            .with_shortcut("g")
            .is_err()
    );
}
