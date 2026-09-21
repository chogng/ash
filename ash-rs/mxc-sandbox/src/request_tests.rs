use super::Request;
use ash_file_access::Dir;
use ash_sandboxing::{
    FileSystemAccess, HostReadScope, NetworkAccess, SandboxCommand, SandboxPolicy, SandboxScope,
};

fn request(dir: &Dir) -> Request {
    crate::policy::request(
        &SandboxCommand::new(
            "program with spaces",
            ["a b", "", "quote\"", "尾部\\"],
            dir.canonical_path(),
        ),
        SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
        &SandboxScope::single(dir.clone()).with_host_read(HostReadScope::Minimal),
    )
    .unwrap()
}

#[test]
fn terminal_handoff_preserves_explicit_environment_and_filesystem_identity() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let dir = Dir::open_local(&work).unwrap();
    let mut prepared = request(&dir);
    prepared.set_env(&[("ASH_TEST".into(), "a=b 中文".into())]);
    let encoded = serde_json::to_string(&prepared).unwrap();
    drop(dir);
    let decoded: Request = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.inner.env, Some(vec!["ASH_TEST=a=b 中文".into()]));
    assert!(!decoded.inner.inherit_default_env);
    assert!(decoded.inner.lifecycle.destroy_on_exit);
    assert!(!decoded.inner.lifecycle.preserve_policy);
    assert_eq!(decoded.inner.script_code, prepared.inner.script_code);
    assert_eq!(
        decoded.inner.policy.readwrite_paths,
        prepared.inner.policy.readwrite_paths
    );
    decoded.snapshot.validate().unwrap();
    std::fs::rename(&work, temp.path().join("old-work")).unwrap();
    std::fs::create_dir(&work).unwrap();
    assert!(decoded.snapshot.validate().is_err());
    assert!(decoded.prepare().is_err());
}

#[test]
fn explicit_empty_environment_stays_empty_after_terminal_handoff() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut prepared = request(&dir);
    prepared.set_env(&[]);
    let decoded: Request =
        serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
    assert_eq!(decoded.inner.env, Some(Vec::new()));
    assert!(!decoded.inner.inherit_default_env);
}

#[cfg(unix)]
#[test]
fn terminal_handoff_keeps_managed_proxy_and_network_restrictions() {
    use ash_sandboxing::ManagedNetworkAccess;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command =
        SandboxCommand::new("/bin/sh", ["-c", "exit 0"], dir.canonical_path()).with_network_proxy(
            ManagedNetworkAccess::new(3128.try_into().unwrap(), 3128.try_into().unwrap()),
        );
    let prepared = crate::policy::request(
        &command,
        SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed),
        &SandboxScope::single(dir).with_host_read(HostReadScope::Minimal),
    )
    .unwrap();
    let mut decoded: Request =
        serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
    decoded.restore_runtime_policy();
    assert_eq!(
        decoded.inner.policy.network_proxy.address.unwrap().to_url(),
        "http://127.0.0.1:3128"
    );
    assert!(decoded.inner.policy.runtime_network_proxy_specified);
    assert!(decoded.inner.policy.network_mode_specified);
    assert!(matches!(
        decoded.inner.policy.default_network_policy,
        wxc_common::models::NetworkPolicy::Block
    ));
    assert!(!decoded.inner.policy.allow_local_network);
}
