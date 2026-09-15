use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolInteractionService;
use ash_protocol::ActionApprovalDecision;
use network_proxy::NetworkDecision;
use network_proxy::NetworkDecisionFuture;
use network_proxy::NetworkPolicy;
use network_proxy::NetworkPolicyHandle;
use network_proxy::NetworkRequest;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Binds the proxy's observed destination to the running Tool and Core's approval authority.
pub(crate) fn for_execution(
    parent: ActionReviewRequest,
    execution_id: String,
    interactions: Arc<dyn ToolInteractionService>,
) -> NetworkPolicyHandle {
    NetworkPolicyHandle::new(ExecutionNetworkPolicy {
        parent,
        execution_id,
        interactions,
        sequence: AtomicU64::new(0),
    })
}

struct ExecutionNetworkPolicy {
    parent: ActionReviewRequest,
    execution_id: String,
    interactions: Arc<dyn ToolInteractionService>,
    sequence: AtomicU64,
}

impl NetworkPolicy for ExecutionNetworkPolicy {
    fn decide(
        &self,
        target: NetworkRequest,
        cancellation: CancellationToken,
    ) -> NetworkDecisionFuture<'_> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let canonical = serde_json::to_vec(&serde_json::json!({
            "execution": self.execution_id,
            "parent": self.parent.action().digest().as_str(),
            "sequence": sequence,
            "protocol": target.protocol().as_str(),
            "host": target.host(),
            "port": target.port(),
            "method": target.method(),
        }))
        .expect("network request contains serializable primitives");
        let review = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::NetworkRequest,
                format!(
                    "{} connection to {}",
                    target.protocol().as_str(),
                    target.authority()
                ),
                CapabilitySet::new([Capability::new(
                    CapabilityKind::Network,
                    format!("{}://{}", target.protocol().as_str(), target.authority()),
                )]),
            )
            .with_network_target(
                target.protocol().as_str(),
                target.host(),
                Some(target.port()),
            ),
            self.parent.provenance().clone(),
            SandboxCompatibility::NotApplicable {
                reason:
                    "the managed proxy enforces this request while the process remains sandboxed"
                        .into(),
            },
            self.parent.action_policy_revision().clone(),
        );
        let interactions = Arc::clone(&self.interactions);
        Box::pin(async move {
            // Core's durable interaction waiter is synchronous. Keep it off the proxy IO thread.
            match tokio::task::spawn_blocking(move || {
                interactions.approve_network(&review, &cancellation)
            })
            .await
            {
                Ok(Ok(ActionApprovalDecision::ApproveOnce)) => NetworkDecision::Allow,
                Ok(Ok(ActionApprovalDecision::Decline)) => {
                    NetworkDecision::Deny("network request denied by policy or user".into())
                }
                Ok(Err(error)) => NetworkDecision::Deny(error.to_string()),
                Err(_) => NetworkDecision::Deny("network approval authority stopped".into()),
            }
        })
    }
}
