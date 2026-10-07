use super::*;
use std::fs;

#[test]
fn scope_requires_one_environment_and_non_overlapping_grants() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let nested = first.join("nested");
    fs::create_dir_all(&nested).unwrap();

    let first = Dir::open_local(&first).unwrap();
    let nested = Dir::open_local(&nested).unwrap();
    let error = SandboxScope::new(
        first.clone(),
        vec![
            SandboxDirGrant::new(first, SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(nested, SandboxDirAccess::ReadOnly),
        ],
        Vec::new(),
    )
    .unwrap_err();

    assert!(matches!(error, SandboxError::InvalidScope(_)));
}

#[test]
fn scope_allows_grants_below_one_hidden_storage_root() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();

    let storage = Dir::open_local(root.path()).unwrap();
    let first = Dir::open_local(first).unwrap();
    let second = Dir::open_local(second).unwrap();
    let scope = SandboxScope::new(
        first.clone(),
        vec![
            SandboxDirGrant::new(first, SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(second, SandboxDirAccess::ReadWrite),
        ],
        vec![storage],
    )
    .unwrap();

    assert_eq!(scope.grants().len(), 2);
    assert_eq!(scope.hidden_dirs().len(), 1);
}
