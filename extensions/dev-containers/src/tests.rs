use super::*;

#[test]
fn rejects_unconfigured_or_non_directory_sources() {
    let temp = tempfile::tempdir().unwrap();
    assert!(workspace(temp.path()).is_err());
    std::fs::create_dir(temp.path().join(".devcontainer")).unwrap();
    std::fs::write(temp.path().join(".devcontainer/devcontainer.json"), "{}").unwrap();
    assert_eq!(
        workspace(temp.path()).unwrap(),
        dunce::canonicalize(temp.path()).unwrap()
    );
}

#[test]
fn rejects_option_injection_and_noncanonical_runtime_roots() {
    for id in ["--all", "deadbeef; rm", "", "../../container"] {
        assert!(!valid_container_id(id));
    }
    assert!(valid_container_id(&"a".repeat(64)));
    for root in ["relative", "/work/../root", "/work/./root", "/work\0root"] {
        assert!(!valid_root(root));
    }
    assert!(valid_root("/workspaces/project with spaces"));
}
