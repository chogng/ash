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

#[cfg(unix)]
#[test]
fn gpg_ipc_discovery_resolves_home_paths_without_widening_runtime_denials() {
    let candidates = |values: &[(&str, &str)]| {
        super::sensitive_ipc_candidates(
            Path::new("/workspace"),
            |key| {
                values
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).into())
            },
            1234,
        )
    };
    let paths = candidates(&[
        ("HOME", "/home/test"),
        ("GNUPGHOME", "keys"),
        ("XDG_RUNTIME_DIR", "/runtime"),
        ("GPG_AGENT_INFO", "/forward/agent:123:1"),
        ("SSH_AUTH_SOCK", "ssh-agent"),
    ]);
    for path in [
        "/home/test/.gnupg/S.gpg-agent",
        "/home/test/.gnupg/S.gpg-agent.extra",
        "/workspace/keys/S.gpg-agent",
        "/workspace/keys/S.gpg-agent.ssh",
        "/runtime/gnupg",
        "/run/user/1234/gnupg",
        "/var/run/user/1234/gnupg",
        "/forward/agent",
        "/workspace/ssh-agent",
    ] {
        assert!(paths.contains(&path.into()), "missing {path}: {paths:?}");
    }
    for path in [
        "/runtime",
        "/run/user/1234",
        "/var/run/user/1234",
        "/home/test/.gnupg",
        "/workspace/keys",
    ] {
        assert!(
            !paths.contains(&path.into()),
            "overbroad IPC denial: {path}"
        );
    }
    let empty = candidates(&[
        ("HOME", ""),
        ("GNUPGHOME", ""),
        ("XDG_RUNTIME_DIR", "relative"),
    ]);
    assert_eq!(
        empty.len(),
        4,
        "empty or invalid directories must not deny the workload cwd: {empty:?}"
    );
    let fallback = candidates(&[("HOME", "/home/test"), ("GNUPGHOME", "")]);
    assert!(fallback.contains(&"/home/test/.gnupg/S.gpg-agent".into()));
    assert!(!fallback.contains(&"/workspace/S.gpg-agent".into()));
}

#[cfg(windows)]
#[test]
fn windows_command_path_preserves_cmd_syntax_and_argument_slashes() {
    use std::os::windows::process::CommandExt;

    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    let command = ash_sandboxing::SandboxCommand::new(
        system.join("System32/cmd.exe"),
        ["/d", "/c", "echo https://example.test/a/b & exit /b 125"],
        dir.canonical_path(),
    );
    let request = super::request(
        &command,
        ash_sandboxing::SandboxPolicy::new(
            FileSystemAccess::DirectoryWrite,
            ash_sandboxing::NetworkAccess::Denied,
        ),
        &SandboxScope::single(dir).with_host_read(ash_sandboxing::HostReadScope::Minimal),
    )
    .unwrap();
    // Exercise the serialized command with cmd's parser even on hosts that
    // cannot create a PSEC environment. Keep its /c payload unchanged.
    let output = std::process::Command::new(system.join("System32").join("cmd.exe"))
        .args(["/d", "/s", "/c"])
        .raw_arg(format!("\"{}\"", request.command_line))
        .current_dir(&request.cwd)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    assert_eq!(
        std::str::from_utf8(&output.stdout).unwrap().trim(),
        "https://example.test/a/b"
    );
    assert!(output.stderr.is_empty(), "{output:?}");
}

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
    let sdk = super::sdk_request(&request).unwrap();
    let ui = sdk.ui.unwrap();
    assert!(!ui.disable);
    assert_eq!(ui.clipboard, mxc_sdk::v1::ClipboardPolicy::None);
    assert!(!ui.allow_input_injection);
    let mxc_sdk::v1::Containment::ProcessContainer(process) = sdk.containment else {
        panic!("Windows must use ProcessContainer");
    };
    let ui = process.ui.unwrap();
    assert_eq!(
        ui.isolation,
        mxc_sdk::v1::configs::ProcessContainerUiIsolation::Desktop
    );
    assert!(!ui.desktop_system_control);
    assert_eq!(
        ui.system_settings,
        mxc_sdk::v1::configs::ProcessContainerSystemSettings::None
    );
    assert!(!ui.ime);
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
