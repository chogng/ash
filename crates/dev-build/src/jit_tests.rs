use super::*;

#[test]
fn package_overrides_beat_child_globals_and_profile_inheritance_matches_cargo() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("Cargo.toml"), "[profile.dev]\noverflow-checks=false\n[profile.dev.package.selected]\noverflow-checks=true\n[profile.dev-small]\ninherits=\"dev\"\noverflow-checks=false\n").unwrap();
    assert!(overflow_checks(root.path(), "selected").unwrap());
    assert!(!overflow_checks(root.path(), "other").unwrap());
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[profile.dev-small]\ninherits=\"release\"\n",
    )
    .unwrap();
    assert!(!overflow_checks(root.path(), "selected").unwrap());
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[profile.dev-small]\ninherits=\"cycle\"\n[profile.cycle]\ninherits=\"dev-small\"\n",
    )
    .unwrap();
    assert!(overflow_checks(root.path(), "selected").is_err());
}
