use super::*;
use ash_action_policy::ApprovalRequest;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySelector;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::CapabilitySet;

struct DomainPolicy;
impl ActionPolicyService for DomainPolicy {
    fn revision(&self) -> String {
        "domain".into()
    }
    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
            request.action().digest().clone(),
            CapabilitySet::new([]),
            "domain request",
        )))
    }
}

#[test]
fn every_source_and_approval_mode_obeys_shared_denials_and_managed_modes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(ConfigStore::open(directory.path().join("config.db")).unwrap());
    store
        .apply(ash_config::ConfigCommandRequest {
            command_id: ash_protocol::CommandId::new("deny-all").unwrap(),
            expected_revision: ash_config::ConfigRevision::new(0),
            command: ash_config::UserConfigCommand::UpsertExecPolicyRule {
                rule: ExecPolicyRule::new(
                    ExecPolicyRuleId::new("deny-all"),
                    ExecPolicySelector::Any,
                    ExecPolicyEffect::Deny("user restriction".into()),
                ),
            },
        })
        .unwrap();
    let policy = SharedExecutionPolicy {
        owner: Arc::new(DomainPolicy),
        config: Some(store),
        runtime: None,
        environment: Arc::new(RwLock::new(EnvRuntimeConfig::default())),
    };
    for source in [
        ActionSource::BuiltInTool,
        ActionSource::McpServer,
        ActionSource::Plugin,
    ] {
        let request = ActionReviewRequest::new(
            ash_action_policy::ResolvedAction::new(
                ActionDigest::from_canonical_bytes(b"same action"),
                ActionKind::SystemOperation,
                "action",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(source, "provider"),
            ash_action_policy::SandboxCompatibility::NotApplicable {
                reason: "host operation".into(),
            },
            ActionPolicyRevision::new("domain"),
        );
        for mode in ash_protocol::ApprovalMode::ALL {
            assert!(matches!(
                ash_core::decide_turn_action(
                    &policy,
                    &policy.revision(),
                    mode,
                    &request,
                    &ash_async_utils::CancellationSource::new().token()
                ),
                Ok(ExecutionDecision::Block(_))
            ));
        }
    }
    let mut environment = policy.environment.write().unwrap();
    environment.tools.requirements = Ok(ash_config::ManagedPermissions {
        source: std::path::PathBuf::from("/system/requirements.toml"),
        values: ash_config::PermissionRequirements {
            allowed_approval_modes: Some(vec![ash_protocol::ApprovalMode::Manual]),
            ..Default::default()
        },
    });
    drop(environment);
    assert!(
        policy
            .check_approval_mode(ash_protocol::ApprovalMode::BypassPermissions)
            .is_err()
    );
}

#[test]
fn disabled_prompt_categories_are_hard_constraints_in_every_approval_mode() {
    let mut environment = EnvRuntimeConfig::default();
    let mut config = ash_config::ResolvedConfig::default();
    config.permissions.approval_prompts = ash_config::ApprovalPromptControls {
        commands: false,
        file_mutations: false,
        sandbox_retries: false,
        network: false,
        mcp: false,
        permission_requests: false,
    };
    environment.tools = crate::local_tools::LocalToolConfig::from_resolved(&config);
    let policy = SharedExecutionPolicy {
        owner: Arc::new(DomainPolicy),
        config: None,
        runtime: None,
        environment: Arc::new(RwLock::new(environment)),
    };
    for (kind, source) in [
        (
            ActionKind::LocalProcess(ash_protocol::ProcessInvocationKind::Direct),
            ActionSource::BuiltInTool,
        ),
        (ActionKind::FileSystemMutation, ActionSource::BuiltInTool),
        (ActionKind::NetworkRequest, ActionSource::BuiltInTool),
        (ActionKind::SystemOperation, ActionSource::McpServer),
    ] {
        let request = ActionReviewRequest::new(
            ash_action_policy::ResolvedAction::new(
                ActionDigest::from_canonical_bytes(b"requires prompt"),
                kind,
                "action",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(source, "provider"),
            ash_action_policy::SandboxCompatibility::NotApplicable {
                reason: "unsandboxed operation".into(),
            },
            ActionPolicyRevision::new("domain"),
        );
        for mode in ash_protocol::ApprovalMode::ALL {
            assert!(matches!(
                ash_core::decide_turn_action(
                    &policy,
                    &policy.revision(),
                    mode,
                    &request,
                    &ash_async_utils::CancellationSource::new().token()
                ),
                Ok(ExecutionDecision::Block(_))
            ));
        }
        assert!(
            policy
                .validate_execution(
                    &request,
                    ash_protocol::ToolExecutionAuthority::ApprovedOnce {
                        request_id: ash_protocol::RequestId::new("stale").unwrap()
                    },
                    &ash_async_utils::CancellationSource::new().token()
                )
                .is_err()
        );
    }
}

#[test]
fn new_network_rules_block_local_processes_until_the_runtime_enforces_managed_egress() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(ConfigStore::open(directory.path().join("config.db")).unwrap());
    let environment = Arc::new(RwLock::new(EnvRuntimeConfig::default()));
    let policy = SharedExecutionPolicy {
        owner: Arc::new(DomainPolicy),
        config: Some(Arc::clone(&store)),
        runtime: None,
        environment: Arc::clone(&environment),
    };
    let request = ActionReviewRequest::new(
        ash_action_policy::ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"local process"),
            ActionKind::LocalProcess(ash_protocol::ProcessInvocationKind::Direct),
            "command",
            CapabilitySet::new([]),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "local"),
        ash_action_policy::SandboxCompatibility::NotApplicable {
            reason: "test fixture".into(),
        },
        ActionPolicyRevision::new("domain"),
    );
    let cancellation = ash_async_utils::CancellationSource::new();
    assert!(
        policy
            .validate_execution(
                &request,
                ash_protocol::ToolExecutionAuthority::Sandboxed,
                &cancellation.token()
            )
            .is_ok()
    );
    store
        .apply(ash_config::ConfigCommandRequest {
            command_id: ash_protocol::CommandId::new("require-network-approval").unwrap(),
            expected_revision: ash_config::ConfigRevision::new(0),
            command: ash_config::UserConfigCommand::UpsertExecPolicyRule {
                rule: ExecPolicyRule::new(
                    ExecPolicyRuleId::new("exact-target"),
                    ExecPolicySelector::Network {
                        protocol: None,
                        host: ash_execpolicy::HostMatcher::exact("example.test"),
                        port: None,
                    },
                    ExecPolicyEffect::RequireApproval,
                ),
            },
        })
        .unwrap();
    assert!(
        policy
            .validate_execution(
                &request,
                ash_protocol::ToolExecutionAuthority::Sandboxed,
                &cancellation.token()
            )
            .unwrap_err()
            .to_string()
            .contains("network permission policy is pending")
    );
    environment.write().unwrap().tools =
        crate::local_tools::LocalToolConfig::from_resolved(&store.committed_snapshot().values);
    assert!(
        policy
            .validate_execution(
                &request,
                ash_protocol::ToolExecutionAuthority::Sandboxed,
                &cancellation.token()
            )
            .is_ok()
    );
}
