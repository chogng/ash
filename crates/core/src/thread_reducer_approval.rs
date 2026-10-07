use crate::CoreError;
use crate::thread_reducer::ThreadSnapshot;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::SandboxDenialOutput;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionAuthority;
use ash_protocol::TurnId;

pub(super) fn validate_escalation_authority(
    snapshot: &ThreadSnapshot,
    turn_id: &TurnId,
    tool_call_id: &ToolCallId,
    action_digest: &str,
    policy_revision: &str,
    denial: &SandboxDenialOutput,
    authority: &ToolExecutionAuthority,
) -> Result<(), CoreError> {
    match authority {
        ToolExecutionAuthority::UnsandboxedGrant { .. }
        | ToolExecutionAuthority::ExecPolicyGranted { .. }
        | ToolExecutionAuthority::AutoReviewed { .. }
        | ToolExecutionAuthority::PermissionBypassed => Ok(()),
        ToolExecutionAuthority::ApprovedOnce { request_id } => {
            let item_id = snapshot.items.iter().find_map(|item| match item {
                ThreadItem::ToolCall {
                    item_id,
                    turn_id: item_turn_id,
                    tool_call_id: item_call_id,
                    ..
                } if item_turn_id == turn_id && item_call_id == tool_call_id => Some(item_id),
                _ => None,
            });
            let Some(item_id) = item_id else {
                return Err(CoreError::Journal(
                    "approved tool escalation must reference its exact Tool Call item".into(),
                ));
            };
            let matches_resolved_approval = snapshot.resolved_interactions.iter().any(|resolved| {
                resolved.turn_id == *turn_id
                    && resolved.interaction.request_id == *request_id
                    && resolved.interaction.item_id.as_ref() == Some(item_id)
                    && matches!(
                        (&resolved.interaction.request, &resolved.response),
                        (
                            AgentRequest::Approval { request },
                            AgentResponse::Approval { response },
                        ) if response.decision == ActionApprovalDecision::ApproveOnce
                            && request.action_digest == action_digest
                            && request.policy_revision == policy_revision
                            && request.sandbox_denial.as_ref() == Some(denial)
                    )
            });
            if matches_resolved_approval {
                Ok(())
            } else {
                Err(CoreError::Journal(
                    "approved tool escalation must match a resolved exact sandbox approval".into(),
                ))
            }
        }
        ToolExecutionAuthority::Sandboxed => Err(CoreError::Journal(
            "tool escalation requires a validated unsandboxed authority".into(),
        )),
    }
}
