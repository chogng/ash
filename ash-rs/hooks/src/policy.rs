use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ProcessInvocationKind;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_config::HookAction;
use ash_config::HookConfig;
use core_api::ActionPolicyService;
use core_api::CoreError;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_tool_executor::CommandExecutionAuthority;

pub(crate) fn execution_authority(
    hook: &HookConfig,
    dir: &Dir,
    policy: &dyn ActionPolicyService,
    cancellation: &CancellationToken,
) -> Result<CommandExecutionAuthority, CoreError> {
    let review = review_request(hook, dir, policy.revision())?;
    let decision = policy.decide(&review, cancellation)?;
    match decision {
        ExecutionDecision::RunSandboxed(policy) => Ok(CommandExecutionAuthority::Sandboxed(policy)),
        ExecutionDecision::RunExecPolicyGranted(grant) => {
            validate_grant(
                hook,
                grant.matches(
                    review.action().digest(),
                    review.action().required_capabilities(),
                    review.action_policy_revision(),
                ),
                "execution-policy",
            )?;
            Ok(CommandExecutionAuthority::Unrestricted)
        }
        ExecutionDecision::RunAutoReviewed(grant) => {
            validate_grant(
                hook,
                grant.matches(
                    review.action().digest(),
                    review.action().required_capabilities(),
                    review.action_policy_revision(),
                ),
                "automatic-review",
            )?;
            Ok(CommandExecutionAuthority::Unrestricted)
        }
        ExecutionDecision::RunUnsandboxed { .. } => Ok(CommandExecutionAuthority::Unrestricted),
        ExecutionDecision::AskUser(_) => Err(CoreError::Policy(format!(
            "Hook '{}' requires interactive approval and was not executed",
            hook.id
        ))),
        ExecutionDecision::RunWithPermissionBypass(_)
        | ExecutionDecision::ReviseAction(_)
        | ExecutionDecision::Block(_) => Err(CoreError::Policy(format!(
            "Hook '{}' was blocked by policy",
            hook.id
        ))),
    }
}

fn validate_grant(hook: &HookConfig, matches: bool, grant_kind: &str) -> Result<(), CoreError> {
    if matches {
        return Ok(());
    }
    Err(CoreError::Policy(format!(
        "Hook '{}' received an {grant_kind} grant for another action",
        hook.id
    )))
}

pub(crate) fn review_request(
    hook: &HookConfig,
    dir: &Dir,
    policy_revision: String,
) -> Result<ActionReviewRequest, CoreError> {
    let HookAction::Process { program, args } = &hook.action;
    let canonical = serde_json::to_vec(&serde_json::json!({
        "execution_contract": "sandbox-v2-scoped-host-acl",
        "hook_id": hook.id.as_str(),
        "program": program,
        "arguments": args,
        "working_directory": dir.canonical_path(),
    }))
    .map_err(|error| CoreError::Policy(format!("could not canonicalize Hook action: {error}")))?;
    let capabilities = CapabilitySet::new([
        Capability::new(
            CapabilityKind::FileRead,
            dir.canonical_path().display().to_string(),
        ),
        Capability::new(
            CapabilityKind::FileWrite,
            dir.canonical_path().display().to_string(),
        ),
        Capability::new(CapabilityKind::ProcessSpawn, program.clone()),
    ]);
    Ok(ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(canonical),
            ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            format!("run configured Hook '{}'", hook.id),
            capabilities,
        ),
        ActionProvenance::new(ActionSource::User, hook.id.as_str()),
        SandboxCompatibility::Supported(
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
                .with_host_acl_changes(ash_sandboxing::HostAclChanges::Scoped),
        ),
        ActionPolicyRevision::new(policy_revision),
    ))
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
