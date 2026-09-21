use super::filesystem_from_resolved;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::MissingPathBehavior;
use ash_sandboxing::SandboxDirAccess;
use ash_sandboxing::SandboxDirGrant;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxPathRule;
use ash_sandboxing::SandboxScope;
use std::path::Path;

#[cfg(target_os = "windows")]
#[test]
fn windows_policy_allows_required_desktop_resources_but_keeps_sensitive_ui_blocked() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command =
        ash_sandboxing::SandboxCommand::new("cmd.exe", ["/c", "exit", "0"], dir.canonical_path());
    let request = super::request(
        &command,
        ash_sandboxing::SandboxPolicy::new(
            FileSystemAccess::ReadOnly,
            ash_sandboxing::NetworkAccess::Denied,
        ),
        &SandboxScope::single(dir),
    )
    .unwrap();
    let policy = request.inner.policy;
    assert!(!policy.ui.disable);
    assert!(matches!(
        policy.ui.clipboard,
        wxc_common::models::ClipboardPolicy::None
    ));
    assert!(!policy.ui.injection);
    assert_eq!(policy.base_process_ui.isolation, "desktop");
    assert!(!policy.base_process_ui.desktop_system_control);
    assert_eq!(policy.base_process_ui.system_settings, "none");
    assert!(!policy.base_process_ui.ime);
    assert!(!policy.fallback.allow_dacl_mutation);
}

#[test]
fn writable_grants_protect_existing_metadata_without_creating_absent_paths() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["work", "reference", "work/.agents"] {
        std::fs::create_dir(temp.path().join(name)).unwrap();
    }
    // Git worktrees use a metadata file rather than a directory.
    std::fs::write(temp.path().join("work/.git"), "gitdir: elsewhere").unwrap();
    let storage = Dir::open_local(temp.path()).unwrap();
    let work = Dir::open_local(temp.path().join("work")).unwrap();
    let reference = Dir::open_local(temp.path().join("reference")).unwrap();
    let scope = SandboxScope::new(
        work.clone(),
        vec![
            SandboxDirGrant::new(work.clone(), SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(reference.clone(), SandboxDirAccess::ReadOnly),
        ],
        vec![storage.clone()],
    )
    .unwrap();
    for access in [
        FileSystemAccess::DirectoryWrite,
        FileSystemAccess::FullAccess,
    ] {
        let resolved = scope.resolve_filesystem(access).unwrap();
        let policy = filesystem_from_resolved(&resolved).unwrap();
        assert_eq!(
            policy.readwrite_paths,
            [work.canonical_path().to_str().unwrap()]
        );
        assert_eq!(
            policy.readonly_paths,
            [
                reference.canonical_path().to_owned(),
                work.canonical_path().join(".agents"),
                work.canonical_path().join(".git"),
            ]
            .map(|path| path.to_str().unwrap().to_owned())
        );
        assert_eq!(
            policy.denied_paths,
            [storage.canonical_path().to_str().unwrap()]
        );
        for name in [".codex", ".ash"] {
            assert!(!work.canonical_path().join(name).exists());
        }
    }
}

#[test]
fn an_empty_work_directory_keeps_its_write_grant() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let resolved = SandboxScope::single(dir.clone())
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .unwrap();
    let policy = filesystem_from_resolved(&resolved).unwrap();
    assert_eq!(
        policy.readwrite_paths,
        [dir.canonical_path().to_str().unwrap()]
    );
    assert!(policy.readonly_paths.is_empty());
    assert!(policy.denied_paths.is_empty());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn exact_path_rules_are_carried_into_the_mxc_filesystem_policy() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("config")).unwrap();
    std::fs::write(temp.path().join(".env"), "secret").unwrap();
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
            SandboxPathRule::exact(
                dir,
                ".env",
                SandboxPathAccess::Denied,
                MissingPathBehavior::Reject,
            )
            .unwrap(),
        ])
        .unwrap();
    let resolved = scope
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .unwrap();

    let policy = filesystem_from_resolved(&resolved).unwrap();

    assert!(
        policy
            .readonly_paths
            .iter()
            .any(|path| Path::new(path)
                == dunce::canonicalize(temp.path().join("config")).unwrap())
    );
    assert!(
        policy
            .denied_paths
            .iter()
            .any(|path| Path::new(path) == dunce::canonicalize(temp.path().join(".env")).unwrap())
    );
}
