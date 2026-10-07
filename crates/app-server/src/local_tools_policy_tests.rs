use super::*;

#[test]
fn network_rules_select_managed_execution_without_broadening_the_default_policy() {
    let mut config = LocalToolConfig::default();
    let initial = configured_shell_policy(&config.snapshot().unwrap());
    assert_eq!(initial.file_system(), FileSystemAccess::DirectoryWrite);
    assert_eq!(initial.network(), NetworkAccess::Denied);
    #[cfg(windows)]
    {
        assert_eq!(
            initial.file_system_isolation(),
            ash_sandboxing::FileSystemIsolation::WindowsAccount
        );
        assert_eq!(
            initial.host_acl_changes(),
            ash_sandboxing::HostAclChanges::ScopedWithTraversal
        );
    }
    #[cfg(not(windows))]
    assert_eq!(
        initial.file_system_isolation(),
        ash_sandboxing::FileSystemIsolation::Strict
    );
    config.user.rules.push(ExecPolicyRule::new(
        ExecPolicyRuleId::new("network"),
        ExecPolicySelector::all([
            ExecPolicySelector::source(Some("built_in_tool".into()), Some("shell-command".into())),
            ExecPolicySelector::Network {
                protocol: Some("https".into()),
                host: ash_execpolicy::HostMatcher::exact("example.com"),
                port: Some(443),
            },
        ]),
        ExecPolicyEffect::RequireApproval,
    ));
    let snapshot = config.snapshot().unwrap();
    assert_eq!(
        configured_shell_policy(&snapshot),
        SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Managed)
            .with_host_acl_changes(local_acl_changes())
            .with_file_system_isolation(local_isolation())
    );
    assert!(matches!(snapshot.default(), ExecPolicyDefault::Deny(_)));
}
