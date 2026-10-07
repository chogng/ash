use super::Request;
use ash_file_access::Dir;
use ash_sandboxing::{
    FileSystemAccess, HostReadScope, NetworkAccess, SandboxCommand, SandboxPolicy, SandboxScope,
};

#[test]
fn startup_diagnostics_keep_sdk_categories_and_system_errors_without_authorizing_replay() {
    use ash_sandboxing::SandboxDenialTiming;
    use ash_sandboxing::SandboxError;
    use mxc_sdk::mxc_common::models::FailurePhase;
    use mxc_sdk::mxc_common::models::ScriptResponse;

    for (phase, code) in [
        (FailurePhase::Rejected, "policy_validation"),
        (FailurePhase::BackendUnavailable, "backend_unavailable"),
        (FailurePhase::LaunchFailed, "backend_error"),
        (FailurePhase::PostLaunchFailed, "backend_error"),
    ] {
        let error = super::spawn_error(ScriptResponse {
            failure_phase: phase,
            error_message: "sandbox creation failed".into(),
            extended_error: "CreateProcessSecurityEnvironment: 0x80070005".into(),
            ..Default::default()
        });
        assert_eq!(
            error,
            SandboxError::StartFailed {
                timing: SandboxDenialTiming::ProcessMayHaveStarted,
                message: format!(
                    "{code}: sandbox creation failed (CreateProcessSecurityEnvironment: 0x80070005)"
                ),
            }
        );
    }
}

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
    assert_eq!(
        decoded.inner.source_contract,
        Some(mxc_sdk::mxc_contract::ContractVersion::V1_0_0)
    );
    assert_eq!(
        decoded.inner.network_enforcement_compatibility,
        mxc_sdk::mxc_common::models::NetworkEnforcementCompatibility::Strict
    );
    assert_eq!(
        decoded.inner.default_env_compatibility,
        mxc_sdk::mxc_common::models::DefaultEnvCompatibility::DefaultBlock
    );
    assert!(decoded.inner.lifecycle.destroy_on_exit);
    assert!(!decoded.inner.lifecycle.preserve_policy);
    assert_eq!(decoded.inner.script_code, prepared.inner.script_code);
    assert_eq!(
        decoded.inner.policy.readwrite_paths,
        prepared.inner.policy.readwrite_paths
    );
    #[cfg(target_os = "macos")]
    assert_eq!(decoded.seatbelt_rules, prepared.seatbelt_rules);
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

#[test]
fn chunked_terminal_handoff_keeps_large_environment_and_prepared_file_authority() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut prepared = request(&dir);
    let value = "🧊中文=\\\"".repeat(4000);
    prepared.set_env(&[("WORKLOAD_VALUE".into(), value.clone())]);
    let mut helper_environment = std::collections::HashMap::new();
    crate::pty_transport::encode(
        &serde_json::to_string(&prepared).unwrap(),
        &mut helper_environment,
    )
    .unwrap();
    let decoded: Request =
        serde_json::from_str(&crate::pty_transport::decode(helper_environment.iter()).unwrap())
            .unwrap();
    assert_eq!(
        decoded.inner.env,
        Some(vec![format!("WORKLOAD_VALUE={value}")])
    );
    assert!(!decoded.inner.inherit_default_env);
    assert_eq!(decoded.inner.script_code, prepared.inner.script_code);
    assert_eq!(
        decoded.inner.policy.readwrite_paths,
        prepared.inner.policy.readwrite_paths
    );
    assert_eq!(
        decoded.inner.policy.denied_paths,
        prepared.inner.policy.denied_paths
    );
    assert_eq!(decoded.snapshot, prepared.snapshot);
    decoded.snapshot.validate().unwrap();
}

#[test]
fn terminal_handoff_cannot_add_host_acl_authority() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut value = serde_json::to_value(request(&dir)).unwrap();
    value["host_acl_scope"] = serde_json::json!({ "roots": [dir.canonical_path()] });
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn backend_launch_failure_reaches_the_caller_with_the_sdk_diagnosis() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut prepared = request(&dir);
    prepared.set_bubblewrap_executable(&temp.path().join("missing-bwrap"));
    let error = match prepared.spawn(mxc_sdk::mxc_common::sandbox_process::StdioMode::Pipes) {
        Ok(_) => panic!("an unavailable selected executable must never start a workload"),
        Err(error) => error,
    };
    let ash_sandboxing::SandboxError::StartFailed { timing, message } = error else {
        panic!("a launch failure must not reopen backend selection: {error}");
    };
    assert_eq!(
        timing,
        ash_sandboxing::SandboxDenialTiming::ProcessMayHaveStarted
    );
    assert!(message.starts_with("backend_error: "), "{message}");
    assert!(message.contains("Bubblewrap"), "{message}");
    assert!(message.contains("not installed"), "{message}");
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
        mxc_sdk::mxc_common::models::NetworkPolicy::Block
    ));
    assert!(!decoded.inner.policy.allow_local_network);
}

#[cfg(unix)]
#[test]
fn socket_path_denials_snapshot_the_containing_directory() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("control");
    std::fs::create_dir(&parent).unwrap();
    let path = parent.join("service.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let parent = std::fs::canonicalize(parent).unwrap();
    let path = std::fs::canonicalize(path).unwrap();
    let mut policy = mxc_sdk::mxc_common::models::ContainerPolicy::default();
    policy.denied_paths = vec![path.to_str().unwrap().into()];
    let request = Request::new(
        crate::policy::sdk_request(
            "exit 0".into(),
            temp.path().to_str().unwrap().into(),
            policy,
            NetworkAccess::Denied,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        request
            .inner
            .policy
            .denied_paths
            .contains(&path.to_str().unwrap().to_owned())
    );
    assert!(request.snapshot.paths().any(|saved| saved == parent));
    assert!(!request.snapshot.paths().any(|saved| saved == path));
    request.snapshot.validate().unwrap();
    std::fs::rename(&parent, temp.path().join("old-control")).unwrap();
    std::fs::create_dir(&parent).unwrap();
    assert!(request.snapshot.validate().is_err());
}
