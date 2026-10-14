use super::*;

#[test]
fn inherited_profile_preserves_denials_and_resolves_closed_access_states() {
    let config: PermissionsConfig = toml::from_str(
        r#"
defaultProfile = "child"
[profiles.parent]
fileSystem = "readOnly"
[[profiles.parent.paths]]
pattern = "secrets/**"
access = "denied"
[profiles.child]
extends = "parent"
network = "allowed"
"#,
    )
    .unwrap();
    config.validate().unwrap();
    let resolved = config.resolve("child").unwrap();
    assert_eq!(resolved.file_system, SandboxMode::ReadOnly);
    assert_eq!(resolved.network, CommandNetworkAccess::Allowed);
    let policy = resolved.path_policy().unwrap();
    assert!(!policy.allows(
        std::path::Path::new("secrets/token"),
        ash_file_access::PathOperation::Read
    ));
    assert!(!policy.allows(
        std::path::Path::new("source.rs"),
        ash_file_access::PathOperation::Write
    ));
}

#[test]
fn profiles_reject_cycles_unknown_parents_and_escaping_paths() {
    for source in [
        "defaultProfile = 'missing'",
        "[profiles.one]\nextends = 'two'\n[profiles.two]\nextends = 'one'",
        "[profiles.':workspace']",
        "[[profiles.one.paths]]\npattern = '../outside'\naccess = 'denied'",
    ] {
        let config: PermissionsConfig = toml::from_str(source).unwrap();
        assert!(config.validate().is_err(), "{source}");
    }
}

#[test]
fn system_requirements_intersect_profiles_without_accepting_ambient_grants() {
    let config = PermissionsConfig::default();
    let requirements: crate::PermissionRequirements = toml::from_str(
        r#"
maximumFileSystem = "readOnly"
maximumNetwork = "denied"
hostRead = "grantedRoots"
allowedApprovalModes = ["manual"]
[[paths]]
pattern = "secret"
access = "denied"
"#,
    )
    .unwrap();
    requirements.validate().unwrap();
    let effective = requirements
        .constrain(config.resolve(":fullAccess").unwrap())
        .unwrap();
    assert_eq!(effective.file_system, SandboxMode::ReadOnly);
    assert_eq!(effective.network, CommandNetworkAccess::Denied);
    assert_eq!(effective.host_read, HostReadAccess::GrantedRoots);
    assert!(!effective.path_policy().unwrap().allows(
        std::path::Path::new("secret/token"),
        ash_file_access::PathOperation::Read
    ));
    assert!(
        requirements
            .check_approval_mode(ash_protocol::ApprovalMode::BypassPermissions)
            .is_err()
    );
    let mut invalid = requirements;
    invalid.rules.push(ash_execpolicy::ExecPolicyRule::new(
        ash_execpolicy::ExecPolicyRuleId::new("invalid"),
        ash_execpolicy::ExecPolicySelector::Any,
        ash_execpolicy::ExecPolicyEffect::AllowUnsandboxed,
    ));
    assert!(invalid.validate().is_err());
}

#[test]
fn a_profile_name_cannot_change_the_scope_of_its_read_only_ceiling() {
    let config: PermissionsConfig = toml::from_str(
        "defaultProfile = 'command-defaults'\n[profiles.command-defaults]\nfileSystem = 'readOnly'",
    )
    .unwrap();
    config.validate().unwrap();
    let profile = config.active(crate::ExecutionConfig::default()).unwrap();
    assert_eq!(profile.scope, PermissionProfileScope::AllOperations);
    assert!(!profile.path_policy().unwrap().allows(
        std::path::Path::new("file"),
        ash_file_access::PathOperation::Write
    ));
}
