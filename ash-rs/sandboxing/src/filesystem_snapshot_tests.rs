use super::FilesystemSnapshot;

#[test]
fn handoff_retains_identity_and_rejects_replaced_objects() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("授权目录");
    std::fs::create_dir(&directory).unwrap();
    let file = directory.join("data");
    std::fs::write(&file, "original").unwrap();
    let snapshot = FilesystemSnapshot::capture([directory.clone(), file.clone()]).unwrap();
    let encoded = serde_json::to_string(&snapshot).unwrap();
    let decoded: FilesystemSnapshot = serde_json::from_str(&encoded).unwrap();
    assert_eq!(snapshot, decoded);
    decoded.validate().unwrap();
    std::fs::rename(&file, directory.join("original")).unwrap();
    std::fs::write(&file, "replacement").unwrap();
    assert_eq!(
        decoded.validate().unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    std::fs::remove_file(&file).unwrap();
    assert!(decoded.validate().is_err());
}

#[test]
fn renamed_directory_cannot_authorize_its_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("work");
    std::fs::create_dir(&path).unwrap();
    let snapshot = FilesystemSnapshot::capture([path.clone()]).unwrap();
    std::fs::rename(&path, temp.path().join("old")).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(snapshot.validate().is_err());
}
