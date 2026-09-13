use super::*;
use crate::SandboxDirGrant;
use std::fs;

#[test]
fn exact_and_snapshot_rules_resolve_once_with_deny_precedence() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("config")).unwrap();
    fs::write(temp.path().join("config/settings.json"), "{}").unwrap();
    fs::write(temp.path().join(".env"), "secret").unwrap();
    fs::create_dir_all(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("nested/.env"), "secret").unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::single(dir.clone())
        .with_path_rules(vec![
            SandboxPathRule::exact(
                dir.clone(),
                "config",
                SandboxPathAccess::ReadOnly,
                MissingPathBehavior::Reject,
            )
            .unwrap(),
            SandboxPathRule::pattern(
                dir.clone(),
                "**/.env",
                SandboxPathAccess::Denied,
                PatternMatchTiming::PreparationSnapshot,
            )
            .unwrap(),
        ])
        .unwrap();

    let resolved = scope
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .unwrap();

    assert!(
        resolved
            .readwrite_paths()
            .contains(&dir.canonical_path().to_owned())
    );
    assert!(
        resolved
            .readonly_paths()
            .contains(&dir.canonical_path().join("config"))
    );
    assert_eq!(
        resolved.denied_paths(),
        &[
            dir.canonical_path().join(".env"),
            dir.canonical_path().join("nested/.env"),
        ]
    );
    assert!(!resolved.allows_read(&dir.canonical_path().join(".env")));
    assert!(!resolved.allows_write(&dir.canonical_path().join("config/settings.json")));
    assert!(resolved.allows_write(&dir.canonical_path().join("output.txt")));
}

#[test]
fn rules_must_belong_to_a_granted_directory() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first = Dir::open_local(first.path()).unwrap();
    let second = Dir::open_local(second.path()).unwrap();
    let rule = SandboxPathRule::exact(
        second,
        ".env",
        SandboxPathAccess::Denied,
        MissingPathBehavior::Ignore,
    )
    .unwrap();

    let error = SandboxScope::single(first)
        .with_path_rules(vec![rule])
        .unwrap_err();

    assert!(error.to_string().contains("directory grant"));
}

#[test]
fn continuous_patterns_fail_before_backend_selection() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::new(
        dir.clone(),
        vec![SandboxDirGrant::new(
            dir.clone(),
            SandboxDirAccess::ReadWrite,
        )],
        Vec::new(),
    )
    .unwrap()
    .with_path_rules(vec![
        SandboxPathRule::pattern(
            dir,
            "**/.env",
            SandboxPathAccess::Denied,
            PatternMatchTiming::Continuous,
        )
        .unwrap(),
    ])
    .unwrap();

    let error = scope
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .unwrap_err();

    assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
}

#[test]
fn denied_file_with_a_hard_link_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join(".env"), "secret").unwrap();
    fs::hard_link(temp.path().join(".env"), temp.path().join("alias")).unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::single(dir.clone())
        .with_path_rules(vec![
            SandboxPathRule::pattern(
                dir,
                "**/.env",
                SandboxPathAccess::Denied,
                PatternMatchTiming::PreparationSnapshot,
            )
            .unwrap(),
        ])
        .unwrap();

    let error = scope
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .unwrap_err();
    assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
    assert!(error.to_string().contains("hard links"));
}

#[test]
fn minimal_host_read_requires_an_explicit_read_rule() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("input"), "allowed").unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::single(dir.clone()).with_host_read(HostReadScope::Minimal);
    let resolved = scope
        .resolve_filesystem(FileSystemAccess::ReadOnly)
        .unwrap();

    assert!(resolved.allows_read(&dir.canonical_path().join("input")));
    assert!(!resolved.allows_read(Path::new(if cfg!(windows) {
        r"C:\Windows\outside"
    } else {
        "/outside"
    })));
}
