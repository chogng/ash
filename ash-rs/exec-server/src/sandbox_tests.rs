use super::*;
use ash_sandboxing::SandboxBackend;

#[test]
fn unsupported_mxc_preserves_isolation_and_acl_authority_for_account_selection() {
    let dir = ash_file_access::Dir::open_local(".").unwrap();
    let command = ash_sandboxing::SandboxCommand::new(
        "must-not-start",
        std::iter::empty::<&str>(),
        dir.canonical_path(),
    )
    .with_network_proxy(ash_sandboxing::ManagedNetworkAccess::new(
        3128.try_into().unwrap(),
        3128.try_into().unwrap(),
    ));
    for (isolation, reason) in [
        (
            ash_sandboxing::FileSystemIsolation::Strict,
            "cannot satisfy strict host filesystem isolation",
        ),
        (
            ash_sandboxing::FileSystemIsolation::WindowsAccount,
            "requires scoped filesystem ACL authorization",
        ),
    ] {
        let policy = ash_sandboxing::SandboxPolicy::new(
            ash_sandboxing::FileSystemAccess::ReadOnly,
            ash_sandboxing::NetworkAccess::Managed,
        )
        .with_file_system_isolation(isolation);
        let error = LocalSandbox::new(InstallContext::current())
            .build()
            .prepare(&command, policy, &dir)
            .unwrap_err();
        let ash_sandboxing::SandboxError::BackendUnavailable { message, .. } = error else {
            panic!("{error}")
        };
        assert!(message.contains("mxc:"), "{message}");
        assert!(message.contains("windows:"), "{message}");
        assert!(message.contains(reason), "{message}");
    }
}
