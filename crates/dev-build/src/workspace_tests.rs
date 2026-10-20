use super::*;

#[test]
fn unresolved_artifact_cfg_cannot_select_bindings_or_hide_other_callers() {
    let mut snapshot = Snapshot::default();
    for text in [
        "#![cfg(unix)]\nfn entry() {}",
        "#[cfg(feature=\"alternate\")] use other::entry;",
        "#[cfg_attr(unix, cfg(feature=\"alternate\"))] type Count = u32;",
        "#[cfg(feature=\"alternate\")] fn other_caller() { helper(); }",
        "#[cfg(unix)] mod platform;",
    ] {
        snapshot.files.insert("src/lib.rs".into(), text.into());
        assert!(snapshot.verify_configuration().is_err(), "{text}");
    }
    snapshot.files.insert(
        "src/lib.rs".into(),
        "mod plain; #[cfg(test)] mod tests { #[cfg(unix)] fn test() {} }".into(),
    );
    assert!(snapshot.verify_configuration().is_ok());
}

#[test]
fn module_changes_refresh_semantics_and_configuration_changes_require_a_new_database() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[package]\nname=\"snapshot-fixture\"\nversion=\"0.0.0\"\n[workspace]\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("src/lib.rs"),
        "mod helper; fn entry() {}\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("src/helper.rs"),
        "fn value() -> usize { 1 }\n",
    )
    .unwrap();
    let package = Package::for_source(root.path(), "src/lib.rs").unwrap();
    let mut target = ash_rust_build_ir::Program {
        version: ash_rust_build_ir::VERSION,
        root: 0,
        crate_root: "src/lib.rs".into(),
        functions: vec![],
        sources: vec![],
        check: ash_rust_build_ir::CheckMode::Package,
    };
    assert!(package.verify_library(root.path(), &target).is_ok());
    target.crate_root = "src/main.rs".into();
    assert!(package.verify_library(root.path(), &target).is_err());
    let before = package.snapshot(root.path()).unwrap();
    std::fs::write(
        root.path().join("src/helper.rs"),
        "fn value() -> usize { 2 }\n",
    )
    .unwrap();
    let body = package.snapshot(root.path()).unwrap();
    assert_ne!(before.digest(), body.digest());
    assert!(!body.configuration_changed(&before));
    std::fs::write(root.path().join("src/new.rs"), "fn new() {}\n").unwrap();
    assert!(
        package
            .snapshot(root.path())
            .unwrap()
            .configuration_changed(&body)
    );
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[package]\nname=\"snapshot-fixture\"\nversion=\"0.0.1\"\n[workspace]\n",
    )
    .unwrap();
    assert!(
        package
            .snapshot(root.path())
            .unwrap()
            .configuration_changed(&before)
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("escape.rs"), "fn escape() {}\n").unwrap();
    assert!(
        Package::for_source(
            root.path(),
            outside.path().join("escape.rs").to_str().unwrap()
        )
        .is_err()
    );
}
