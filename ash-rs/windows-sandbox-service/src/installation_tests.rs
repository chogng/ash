use super::*;

#[test]
fn plans_bind_the_executable_and_every_recorded_runtime() {
    let one = serde_json::json!({"serviceSha256": "one", "runtimes": []});
    let another_image = serde_json::json!({"serviceSha256": "two", "runtimes": []});
    let another_user = serde_json::json!({"serviceSha256": "one", "runtimes": ["S-1-5-21-other"]});
    assert_ne!(digest(&one).unwrap(), digest(&another_image).unwrap());
    assert_ne!(digest(&one).unwrap(), digest(&another_user).unwrap());
    assert!(install("").unwrap_err().contains("approval does not match"));
}

#[test]
fn an_unrecorded_file_is_preserved() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("unrelated.txt");
    std::fs::write(&path, b"preserve me").unwrap();
    assert!(validate_layout(root.path()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"preserve me");
}

#[test]
fn a_user_writable_directory_cannot_become_a_service_installation() {
    let root = tempfile::tempdir().unwrap();
    assert!(windows_sandbox::provisioning::validate_service_path(root.path()).is_err());
}
