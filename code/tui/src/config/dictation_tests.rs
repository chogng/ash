use super::DictationShortcutSettings;
use super::LocalDictationSettings;
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

#[test]
fn local_shortcut_edit_rejects_invalid_siblings_without_writing_the_profile() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("config.toml");
    let document = "[tui]\nshowTip = false\n";
    std::fs::write(&path, document).unwrap();
    let store =
        LocalDictationSettings::open(profile.path(), &profile.path().join("state.db")).unwrap();
    assert_eq!(
        store.read().unwrap_err(),
        "Unknown [tui] configuration key: showTip."
    );
    let document = std::fs::read_to_string(&path).unwrap();
    let mut candidate = DictationShortcutSettings::default()
        .with_shortcut("ctrl+y")
        .unwrap();
    candidate.revision = store.store.read_snapshot().unwrap().revision;
    assert_eq!(
        store.write(candidate).unwrap_err(),
        "Unknown [tui] configuration key: showTip."
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), document);
}

#[test]
fn local_profile_persists_shortcut_and_preserves_other_tui_values() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("config.toml");
    std::fs::write(&path, "[tui]\nshowTips = false\n").unwrap();
    let store =
        LocalDictationSettings::open(profile.path(), &profile.path().join("state.db")).unwrap();
    let mut settings = store.read().unwrap().with_shortcut("ctrl+y").unwrap();
    settings.enabled = true;
    let saved = store.write(settings.clone()).unwrap();
    assert!(saved.enabled);
    assert_eq!(saved.shortcut, "ctrl+y");
    assert!(saved.revision > settings.revision);
    assert_eq!(store.read().unwrap(), saved);
    assert!(store.write(settings).is_err());
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("showTips = false")
    );
    let document = std::fs::read_to_string(&path)
        .unwrap()
        .replace("ctrl+y", "ctrl+g");
    std::fs::write(&path, document).unwrap();
    assert_eq!(store.read().unwrap().shortcut, "ctrl+g");
}
