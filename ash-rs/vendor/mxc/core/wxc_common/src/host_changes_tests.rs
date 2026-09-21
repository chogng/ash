use super::HostAclScope;
use std::path::PathBuf;

#[test]
fn read_access_does_not_authorize_host_acl_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let granted = temp.path().join("work");
    let outside = temp.path().join("work-other");
    std::fs::create_dir(&granted).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let child = granted.join("file");
    std::fs::write(&child, b"data").unwrap();
    let scope = HostAclScope::new([granted.clone()]).unwrap();
    scope.check(&granted).unwrap();
    scope.check(&child).unwrap();
    for path in [temp.path(), outside.as_path()] {
        assert_eq!(
            scope.check(path).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
    assert!(HostAclScope::default().check(&granted).is_err());
    assert!(scope.check(&granted.join("missing")).is_err());
}

#[test]
fn missing_roots_cannot_authorize_future_objects() {
    let temp = tempfile::tempdir().unwrap();
    assert!(HostAclScope::new([temp.path().join("missing")]).is_err());
    let empty = HostAclScope::new(Vec::<PathBuf>::new()).unwrap();
    assert!(empty.check(temp.path()).is_err());
}

#[test]
fn replacing_an_authorized_directory_does_not_reuse_its_authority() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("work");
    std::fs::create_dir(&path).unwrap();
    let scope = HostAclScope::new([path.clone()]).unwrap();
    std::fs::rename(&path, temp.path().join("old-work")).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        scope.check(&path).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
}

#[test]
fn serialized_requests_cannot_grant_host_mutation_authority() {
    let request: crate::models::ExecutionRequest = serde_json::from_value(serde_json::json!({
        "host_acl_scope": {"roots": ["C:\\"]},
        "host_filesystem": "ReadWrite",
        "prepared_files": {"objects": []}
    }))
    .unwrap();
    let serialized = serde_json::to_value(request).unwrap();
    assert!(serialized.get("host_acl_scope").is_none());
    assert!(serialized.get("host_filesystem").is_none());
    assert!(serialized.get("prepared_files").is_none());
}

#[cfg(unix)]
#[test]
fn a_link_cannot_expand_the_acl_scope() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, work.join("link")).unwrap();
    let scope = HostAclScope::new([work.clone()]).unwrap();
    assert_eq!(
        scope.check(&work.join("link")).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
}
