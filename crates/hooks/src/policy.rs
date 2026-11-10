use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_config::HookAction;
use ash_config::HookConfig;
use ash_file_access::Dir;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::Capability;
use ash_protocol::CapabilityKind;
use ash_protocol::CapabilitySet;
use ash_protocol::ProcessInvocationKind;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::FileSystemIsolation;
use ash_sandboxing::HostAclChanges;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxDirAccess;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::CommandExecutionAuthority;
use core_api::ActionPolicyService;
use core_api::CoreError;

pub(crate) fn execution_authority(
    hook: &HookConfig,
    dir: &Dir,
    scope: Option<&SandboxScope>,
    policy: &dyn ActionPolicyService,
    cancellation: &CancellationToken,
) -> Result<CommandExecutionAuthority, CoreError> {
    let provenance = ActionProvenance::new(ActionSource::User, hook.id.as_str());
    let review = review_request(hook, dir, scope, policy.revision_for(&provenance))?;
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

/// An action decision can approve execution but cannot widen a Session directory grant.
pub(crate) fn session_authority(
    authority: CommandExecutionAuthority,
    scope: &SandboxScope,
) -> CommandExecutionAuthority {
    let policy = match authority {
        CommandExecutionAuthority::Sandboxed(policy) => policy,
        CommandExecutionAuthority::Unrestricted => {
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
                .with_host_acl_changes(HostAclChanges::Scoped)
        }
    };
    let files = if policy.file_system() == FileSystemAccess::ReadOnly {
        FileSystemAccess::ReadOnly
    } else {
        session_file_access(scope)
    };
    CommandExecutionAuthority::Sandboxed(
        SandboxPolicy::new(files, policy.network())
            .with_host_acl_changes(policy.host_acl_changes())
            .with_file_system_isolation(FileSystemIsolation::Strict),
    )
}

fn session_file_access(scope: &SandboxScope) -> FileSystemAccess {
    if scope.grants()[0].access() == SandboxDirAccess::ReadWrite {
        FileSystemAccess::DirectoryWrite
    } else {
        FileSystemAccess::ReadOnly
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
    scope: Option<&SandboxScope>,
    policy_revision: String,
) -> Result<ActionReviewRequest, CoreError> {
    let HookAction::Process { program, args } = &hook.action;
    let mut action = serde_json::json!({
        "execution_contract": "sandbox-v2-scoped-host-acl",
        "hook_id": hook.id.as_str(),
        "program": program,
        "arguments": args,
        "working_directory": dir.canonical_path(),
    });
    if let Some(scope) = scope {
        action["sandbox_scope"] = scope.policy_identity().into();
    }
    let canonical = serde_json::to_vec(&action).map_err(|error| {
        CoreError::Policy(format!("could not canonicalize Hook action: {error}"))
    })?;
    let access = scope.map_or(SandboxDirAccess::ReadWrite, |scope| {
        scope.grants()[0].access()
    });
    let mut capabilities = vec![Capability::new(
        CapabilityKind::ProcessSpawn,
        program.clone(),
    )];
    if access != SandboxDirAccess::Denied {
        capabilities.push(Capability::new(
            CapabilityKind::FileRead,
            dir.canonical_path().display().to_string(),
        ));
    }
    if access == SandboxDirAccess::ReadWrite {
        capabilities.push(Capability::new(
            CapabilityKind::FileWrite,
            dir.canonical_path().display().to_string(),
        ));
    }
    Ok(ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(canonical),
            ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            format!("run configured Hook '{}'", hook.id),
            CapabilitySet::new(capabilities),
        ),
        ActionProvenance::new(ActionSource::User, hook.id.as_str()),
        SandboxCompatibility::Supported(
            SandboxPolicy::new(
                scope.map_or(FileSystemAccess::DirectoryWrite, session_file_access),
                NetworkAccess::Denied,
            )
            .with_host_acl_changes(HostAclChanges::Scoped),
        ),
        ActionPolicyRevision::new(policy_revision),
    ))
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
