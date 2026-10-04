use super::*;

#[test]
fn local_shortcut_edit_rejects_invalid_siblings_without_writing_the_profile() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("config.toml");
    let document = "[tui]\nshowTip = false\n";
    std::fs::write(&path, document).unwrap();
    let store = LocalTuiSettings::open(profile.path(), &profile.path().join("state.db")).unwrap();
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
    let store = LocalTuiSettings::open(profile.path(), &profile.path().join("state.db")).unwrap();
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

#[test]
fn dashboard_grouping_round_trips_all_modes_in_the_local_profile_and_preserves_siblings() {
    use crate::sessions::SessionGrouping;
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("config.toml");
    std::fs::write(&path, "[tui]\nshowTips = false\ntheme = \"graphite\"\n").unwrap();
    let database = profile.path().join("state.db");
    let store = LocalTuiSettings::open(profile.path(), &database).unwrap();
    assert_eq!(store.read_grouping().unwrap(), SessionGrouping::Status);
    for grouping in [
        SessionGrouping::Model,
        SessionGrouping::Project,
        SessionGrouping::Status,
    ] {
        store.write_grouping(grouping).unwrap();
        let reopened = LocalTuiSettings::open(profile.path(), &database).unwrap();
        assert_eq!(reopened.read_grouping().unwrap(), grouping);
        let snapshot = store.store.read_snapshot().unwrap();
        assert_eq!(snapshot.values.tui["showTips"], serde_json::json!(false));
        assert_eq!(snapshot.values.tui["theme"], serde_json::json!("graphite"));
    }
    let document = std::fs::read_to_string(&path).unwrap().replace(
        "sessionGrouping = \"status\"",
        "sessionGrouping = \"model\"",
    );
    std::fs::write(&path, document).unwrap();
    assert_eq!(store.read_grouping().unwrap(), SessionGrouping::Model);
}

#[test]
fn dashboard_grouping_rejects_invalid_local_candidates_without_overwriting_the_document() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("config.toml");
    std::fs::write(&path, "[tui]\nsessionGrouping = \"invalid\"\n").unwrap();
    let store = LocalTuiSettings::open(profile.path(), &profile.path().join("state.db")).unwrap();
    assert!(store.read_grouping().is_err());
    let document = std::fs::read_to_string(&path).unwrap();
    // A known new choice can replace an invalid grouping; invalid sibling values cannot.
    std::fs::write(
        &path,
        document.replace(
            "sessionGrouping = \"invalid\"",
            "sessionGrouping = \"status\"\ninputMode = \"invalid\"",
        ),
    )
    .unwrap();
    let document = std::fs::read_to_string(&path).unwrap();
    assert!(
        store
            .write_grouping(crate::sessions::SessionGrouping::Project)
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), document);
}
