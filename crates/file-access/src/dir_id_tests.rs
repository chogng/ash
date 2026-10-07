use super::*;
use crate::Dir;

#[test]
#[cfg(unix)]
fn aliases_share_one_directory_identity() {
    let directory = tempfile::tempdir().unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("dir-alias");
    std::os::unix::fs::symlink(directory.path(), &alias).unwrap();

    let canonical = Dir::open_local(directory.path()).unwrap();
    let aliased = Dir::open_local(&alias).unwrap();

    assert_eq!(canonical.id(), aliased.id());
}

#[test]
fn identical_paths_in_different_environments_have_distinct_identities() {
    let directory = tempfile::tempdir().unwrap();
    let first = Dir::from_directory(
        ash_environment::LocalFileDriver::new(EnvId::new("first").unwrap())
            .open_directory(directory.path())
            .unwrap(),
    );
    let second = Dir::from_directory(
        ash_environment::LocalFileDriver::new(EnvId::new("second").unwrap())
            .open_directory(directory.path())
            .unwrap(),
    );

    assert_ne!(first.id(), second.id());
}

#[test]
fn serialized_identity_is_validated_and_normalized() {
    let uppercase = format!("sha256:{}", "AB".repeat(32));
    let identity: DirId = uppercase.parse().unwrap();

    assert_eq!(identity.as_str(), format!("sha256:{}", "ab".repeat(32)));
    assert!("sha256:not-a-digest".parse::<DirId>().is_err());
}
