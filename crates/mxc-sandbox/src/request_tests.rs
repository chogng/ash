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

#[cfg(unix)]
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

#[cfg(unix)]
#[test]
fn workload_environment_adds_socket_denials_without_refreshing_prepared_authority() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let dir = Dir::open_local(&work).unwrap();
    let mut prepared = request(&dir);
    let home = work.join("keys");
    std::fs::create_dir(&home).unwrap();
    let socket = home.join("S.gpg-agent");
    let _agent = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    prepared
        .set_env(&[("GNUPGHOME".into(), "keys".into())])
        .unwrap();
    assert!(
        prepared.denied_paths.contains(
            &std::fs::canonicalize(socket)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        )
    );
    std::fs::rename(&work, temp.path().join("old")).unwrap();
    std::fs::create_dir(&work).unwrap();
    assert!(
        prepared.prepare().is_err(),
        "new environment must not renew a replaced directory grant"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn backend_launch_failure_reaches_the_caller_with_the_sdk_diagnosis() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let mut prepared = request(&dir);
    let executable = temp.path().join("missing-bwrap");
    prepared.set_bubblewrap_executable(&executable);
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
    assert!(message.contains("availability probe"), "{message}");
    assert!(message.contains(executable.to_str().unwrap()), "{message}");
}

#[cfg(unix)]
#[test]
fn managed_proxy_projection_keeps_both_network_directions_restricted() {
    use ash_sandboxing::ManagedNetworkAccess;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let command = SandboxCommand::new("/bin/sh", ["-c", "exit 0"], dir.canonical_path())
        .with_network_proxy(ManagedNetworkAccess::new(3128.try_into().unwrap()));
    let prepared = crate::policy::request(
        &command,
        SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed),
        &SandboxScope::single(dir).with_host_read(HostReadScope::Minimal),
    )
    .unwrap();
    assert_eq!(
        prepared.network,
        super::Network::Managed(3128.try_into().unwrap())
    );
    let sdk = crate::policy::sdk_request(&prepared);
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
fn approved_request_retains_both_network_directions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    for network in [NetworkAccess::Allowed, NetworkAccess::Denied] {
        let prepared = crate::policy::request(
            &SandboxCommand::new("program", ["argument"], dir.canonical_path()),
            SandboxPolicy::new(FileSystemAccess::ReadOnly, network),
            &SandboxScope::single(dir.clone()).with_host_read(HostReadScope::Minimal),
        )
        .unwrap();
        let sdk = crate::policy::sdk_request(&prepared).network.unwrap();
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
        Some(3128.try_into().unwrap()),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        ash_sandboxing::SandboxError::UnsupportedPolicy(_)
    ));
}
