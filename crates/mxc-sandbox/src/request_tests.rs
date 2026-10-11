use super::Request;
use ash_file_access::Dir;
use ash_sandboxing::{
    FileSystemAccess, HostReadScope, NetworkAccess, SandboxCommand, SandboxPolicy, SandboxScope,
};

#[test]
fn startup_diagnostics_keep_sdk_categories_and_system_errors_without_authorizing_replay() {
    use ash_sandboxing::SandboxDenialTiming;
    use ash_sandboxing::SandboxError;
    use mxc_sdk::v1::Error;
    use mxc_sdk::v1::ErrorCode;
    for code in [
        ErrorCode::PolicyValidation,
        ErrorCode::BackendUnavailable,
        ErrorCode::BackendError,
    ] {
        let mut sdk = Error::new(code, "sandbox creation failed");
        sdk.operation = Some("CreateProcessSecurityEnvironment".into());
        sdk.native_code = Some("0x80070005".into());
        let error = super::spawn_error(sdk);
        assert_eq!(
            error,
            SandboxError::StartFailed {
                timing: SandboxDenialTiming::ProcessMayHaveStarted,
                message: format!(
                    "{code}: sandbox creation failed [CreateProcessSecurityEnvironment 0x80070005]"
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
    assert_eq!(decoded.environment, Some(vec!["ASH_TEST=a=b 中文".into()]));
    assert_eq!(
        crate::policy::sdk_request(&decoded)
            .unwrap()
            .inherit_default_environment,
        Some(false)
    );
    assert_eq!(decoded.command_line, prepared.command_line);
    assert_eq!(decoded.readwrite_paths, prepared.readwrite_paths);
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
    assert_eq!(decoded.environment, Some(Vec::new()));
    assert_eq!(
        crate::policy::sdk_request(&decoded)
            .unwrap()
            .inherit_default_environment,
        Some(false)
    );
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
        decoded.environment,
        Some(vec![format!("WORKLOAD_VALUE={value}")])
    );
    assert_eq!(
        crate::policy::sdk_request(&decoded)
            .unwrap()
            .inherit_default_environment,
        Some(false)
    );
    assert_eq!(decoded.command_line, prepared.command_line);
    assert_eq!(decoded.readwrite_paths, prepared.readwrite_paths);
    assert_eq!(decoded.denied_paths, prepared.denied_paths);
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
    let error = match prepared
        .prepare()
        .unwrap()
        .spawn()
        .map_err(super::spawn_error)
    {
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
    let decoded: Request =
        serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
    assert_eq!(
        decoded.network,
        super::Network::Managed(3128.try_into().unwrap())
    );
    let sdk = crate::policy::sdk_request(&decoded).unwrap();
    let network = sdk.network.unwrap();
    assert_eq!(
        network.runtime_config.unwrap().network_proxy.as_deref(),
        Some("http://127.0.0.1:3128")
    );
    assert_eq!(
        network.egress.unwrap().default,
        Some(mxc_sdk::v1::NetworkAction::Deny)
    );
    let ingress = network.ingress.unwrap();
    assert_eq!(ingress.default, Some(mxc_sdk::v1::NetworkAction::Deny));
    assert_eq!(
        ingress.host_loopback,
        Some(mxc_sdk::v1::NetworkAction::Deny)
    );
}

#[test]
fn terminal_handoff_retains_both_network_directions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    for network in [NetworkAccess::Allowed, NetworkAccess::Denied] {
        let prepared = crate::policy::request(
            &SandboxCommand::new("program", ["argument"], dir.canonical_path()),
            SandboxPolicy::new(FileSystemAccess::ReadOnly, network),
            &SandboxScope::single(dir.clone()).with_host_read(HostReadScope::Minimal),
        )
        .unwrap();
        let decoded: Request =
            serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
        assert_eq!(decoded.network, prepared.network);
        let sdk = crate::policy::sdk_request(&decoded)
            .unwrap()
            .network
            .unwrap();
        let action = match network {
            NetworkAccess::Allowed => mxc_sdk::v1::NetworkAction::Allow,
            NetworkAccess::Denied => mxc_sdk::v1::NetworkAction::Deny,
            NetworkAccess::Managed => unreachable!(),
        };
        assert_eq!(sdk.egress.unwrap().default, Some(action));
        let ingress = sdk.ingress.unwrap();
        assert_eq!(ingress.default, Some(action));
        assert_eq!(ingress.host_loopback, Some(action));
    }
}

#[test]
fn terminal_handoff_refuses_network_rules_it_cannot_preserve() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut encoded = serde_json::to_value(request(&dir)).unwrap();
    encoded["network"] = serde_json::json!({ "Denied": { "hostLoopback": "allow" } });
    assert!(serde_json::from_value::<Request>(encoded).is_err());
    let mut encoded = serde_json::to_value(request(&dir)).unwrap();
    encoded["egress_allow"] = serde_json::json!(["example.com"]);
    assert!(serde_json::from_value::<Request>(encoded).is_err());
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
    let mut policy = mxc_sdk::v1::FilesystemPolicy::default();
    policy.denied_paths = vec![path.to_str().unwrap().into()];
    let request = Request::new(
        "exit 0".into(),
        temp.path().to_str().unwrap().into(),
        policy,
        NetworkAccess::Denied,
        None,
    )
    .unwrap();
    assert!(
        request
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

#[cfg(windows)]
#[test]
fn unsupported_managed_policy_does_not_snapshot_files_before_the_account_candidate() {
    // An unsupported candidate must yield the original policy before acquiring file
    // objects; its snapshot errors must not prevent the account backend's preparation.
    let error = Request::new(
        "cmd.exe /c exit 0".into(),
        "C:\\missing-ash-sandbox-work".into(),
        mxc_sdk::v1::FilesystemPolicy::default(),
        NetworkAccess::Managed,
        Some(3128),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        ash_sandboxing::SandboxError::UnsupportedPolicy(_)
    ));
}

#[cfg(not(windows))]
#[test]
fn terminal_handoff_rejects_zero_proxy_ports_at_decoding() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut encoded = serde_json::to_value(request(&dir)).unwrap();
    encoded["network"] = serde_json::json!({ "Managed": 0 });
    assert!(serde_json::from_value::<Request>(encoded).is_err());
}
