use super::*;

#[test]
fn server_requires_a_separate_approval_outside_the_current_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let current = directory.path().join("current");
    let child = current.join("child");
    let other = directory.path().join("other");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::create_dir(&other).unwrap();

    assert!(authorize_workspace_root(&current, &child, |_| panic!("Already granted")).is_ok());
    let denied = authorize_workspace_root(&current, &other, |selected| {
        assert_eq!(selected, other);
        false
    })
    .unwrap_err();
    assert_eq!(denied.kind(), io::ErrorKind::PermissionDenied);
    assert!(authorize_workspace_root(&current, &other, |_| true).is_ok());
}

#[test]
fn directory_picker_lists_names_outside_the_current_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let current = directory.path().join("current");
    let other = directory.path().join("other");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(other.join("project")).unwrap();
    std::fs::write(other.join("private.txt"), "content").unwrap();

    let request = serde_json::json!({ "path": other }).to_string();
    let listing: WebWorkspaceListResult =
        serde_json::from_str(&list_directories(&current, &request).unwrap()).unwrap();
    assert_eq!(listing.directories.len(), 1);
    assert_eq!(listing.directories[0].name, "project");
}
