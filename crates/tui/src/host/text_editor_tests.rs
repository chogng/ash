use super::*;

#[test]
fn opening_configuration_creates_missing_project_file_and_preserves_edits() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("project with spaces/.ash/config.toml");
    prepare_file(&path).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    let content = "# Keep this comment\n[agent]\n";
    std::fs::write(&path, content).unwrap();
    prepare_file(&path).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    assert_eq!(
        editor_command(&path).get_args().last().unwrap(),
        path.as_os_str()
    );
}

#[test]
fn relative_configuration_paths_are_rejected_before_creation() {
    assert_eq!(
        prepare_file(Path::new(".ash/config.toml"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidInput
    );
}
