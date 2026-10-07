use super::*;
use std::path::PathBuf;

#[test]
fn denied_file_inside_writable_grant_is_not_discarded() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let secret = work.join(".env");
    std::fs::write(&secret, "secret").unwrap();

    let mut denied = BTreeSet::new();
    hidden_objects(&secret, &[work], &mut denied).unwrap();

    assert_eq!(denied, BTreeSet::from([secret]));
}

#[test]
fn hidden_parent_keeps_its_granted_descendant_open() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared");
    let work = shared.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(shared.join("secret"), "secret").unwrap();
    std::fs::write(work.join("source"), "source").unwrap();

    let mut denied = BTreeSet::new();
    hidden_objects(&shared, &[work.clone()], &mut denied).unwrap();

    assert!(denied.contains(&shared));
    assert!(denied.contains(&shared.join("secret")));
    assert!(!denied.contains(&work));
    assert!(!denied.contains(&work.join("source")));
}

#[test]
fn a_write_grant_cannot_change_an_outside_file_through_a_hard_link() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let outside = temp.path().join("outside");
    std::fs::write(&outside, "unchanged").unwrap();
    std::fs::hard_link(&outside, work.join("alias")).unwrap();
    let mut policy = mxc_sdk::mxc_common::models::ContainerPolicy::default();
    policy.readwrite_paths.push(work.to_str().unwrap().into());
    assert!(validate(&policy).unwrap_err().contains("multiply linked"));
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
}

#[test]
fn separate_acl_journals_restore_only_their_own_mutations() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let mut one = DaclManager::in_directory(&temp.path().join("journal-one")).unwrap();
    let mut two = DaclManager::in_directory(&temp.path().join("journal-two")).unwrap();
    one.deny_write_access("S-1-5-21-911-912-913-914", &[first])
        .unwrap();
    two.deny_write_access("S-1-5-21-921-922-923-924", &[second])
        .unwrap();
    one.restore_strict().unwrap();
    assert_eq!(
        std::fs::read_dir(temp.path().join("journal-one"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("journal-two"))
            .unwrap()
            .count(),
        1
    );
    two.restore_strict().unwrap();
    assert_eq!(
        std::fs::read_dir(temp.path().join("journal-two"))
            .unwrap()
            .count(),
        0
    );
}

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
fn a_junction_cannot_expand_the_acl_scope() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let junction = work.join("link");
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let scope = HostAclScope::new([work.clone()]).unwrap();
    assert_eq!(
        scope.check(&junction).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
}
