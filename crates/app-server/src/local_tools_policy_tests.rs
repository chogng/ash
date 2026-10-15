use super::*;

#[test]
fn sandbox_managed_ceilings_survive_approval_at_the_executor_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let grant = ash_file_access::Grant::for_environment(
        dir,
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([
            DirPermission::ReadFiles,
            DirPermission::WriteFiles,
            DirPermission::ExecuteCommands,
        ]),
    );
    for selected_profile in [None, Some(":fullAccess")] {
        let mut config = ResolvedConfig::default();
        config.execution.command_file_access = ash_config::CommandFileAccess::DirectoryWrite;
        config.execution.command_network_access = ash_config::CommandNetworkAccess::Allowed;
        config.permissions.default_profile = selected_profile.map(str::to_owned);
        let mut config = LocalToolConfig::from_resolved(&config);
        config.requirements = Ok(ash_config::ManagedPermissions {
            source: PathBuf::from("managed-permissions-fixture"),
            values: ash_config::PermissionRequirements {
                maximum_file_system: Some(ash_protocol::SandboxMode::ReadOnly),
                maximum_network: Some(ash_config::CommandNetworkAccess::Denied),
                host_read: Some(ash_config::HostReadAccess::GrantedRoots),
                ..Default::default()
            },
        });
        let grep = Arc::new(
            grep::Service::new(
                grep::Backend::Ripgrep,
                RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap(),
                None,
            )
            .unwrap(),
        );
        let composition = compose_local_tools_with_config(
            grant.clone(),
            &config,
            Arc::new(DirGrants::default()),
            grep,
            Arc::new(file_search::Service),
            None,
            None,
            Arc::new(ash_core::ThreadController::with_store(Arc::new(
                ash_core::InMemoryThreadStore::default(),
            ))),
        )
        .unwrap();
        let shell = &composition.executors[0];
        crate::tool_executor_adapter::assert_managed_sandbox_execution(
            shell.executor.definition(),
            Arc::clone(&shell.reviewer),
        );
    }
}

#[test]
fn sandbox_configuration_resolves_profiles_and_mandatory_ceilings() {
    let mut config = ResolvedConfig::default();
    config.execution.command_file_access = ash_config::CommandFileAccess::DirectoryWrite;
    config.execution.command_network_access = ash_config::CommandNetworkAccess::Allowed;
    config.permissions.default_profile = Some(":readOnly".into());
    let mut tools = LocalToolConfig::from_resolved(&config);
    tools.requirements = Ok(ash_config::ManagedPermissions {
        source: std::path::PathBuf::from("managed-permissions-fixture"),
        values: ash_config::PermissionRequirements::default(),
    });
    let (profile, policy) = tools.sandbox_configuration().unwrap();
    assert_eq!(profile.name, ":readOnly");
    assert_eq!(policy.file_system(), FileSystemAccess::ReadOnly);
    assert_eq!(policy.network(), NetworkAccess::Denied);
    tools.permissions.default_profile = None;
    let (_, policy) = tools.sandbox_configuration().unwrap();
    assert_eq!(policy.file_system(), FileSystemAccess::DirectoryWrite);
    assert_eq!(policy.network(), NetworkAccess::Allowed);
    let requirements = &mut tools.requirements.as_mut().unwrap().values;
    requirements.maximum_file_system = Some(ash_protocol::SandboxMode::ReadOnly);
    requirements.maximum_network = Some(ash_config::CommandNetworkAccess::Denied);
    let (profile, policy) = tools.sandbox_configuration().unwrap();
    assert_eq!(profile.file_system, ash_protocol::SandboxMode::ReadOnly);
    assert_eq!(policy.file_system(), FileSystemAccess::ReadOnly);
    assert_eq!(policy.network(), NetworkAccess::Denied);
}

#[test]
fn network_rules_select_managed_execution_without_broadening_the_default_policy() {
    let mut config = LocalToolConfig::default();
    config.execution.command_network_access = ash_config::CommandNetworkAccess::Allowed;
    let initial = configured_shell_policy(&config.snapshot().unwrap(), config.execution);
    assert_eq!(initial.file_system(), FileSystemAccess::DirectoryWrite);
    assert_eq!(initial.network(), NetworkAccess::Allowed);
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
        configured_shell_policy(&snapshot, config.execution),
        SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Managed)
            .with_host_acl_changes(local_acl_changes())
            .with_file_system_isolation(local_isolation())
    );
    assert!(matches!(snapshot.default(), ExecPolicyDefault::Deny(_)));
}
