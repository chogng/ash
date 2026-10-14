use ash_async_utils::CancellationToken;
use exec_server_protocol::ExecError;
use exec_server_protocol::ProcessNetworkRequest;
use network_proxy::NetworkDecision;
use network_proxy::NetworkDecisionFuture;
use network_proxy::NetworkPolicy;
use network_proxy::NetworkRequest;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

struct Pending {
    request: ProcessNetworkRequest,
    reply: tokio::sync::oneshot::Sender<NetworkDecision>,
}

/// Exact observed targets waiting for this process's authenticated caller. No reply widens its
/// enclosing kernel sandbox or authorizes a different destination; cancellation removes the lease.
pub(crate) struct NetworkApprovals {
    operation: String,
    requirements: ash_config::PermissionRequirements,
    sequence: AtomicU64,
    pending: Mutex<BTreeMap<String, Pending>>,
}

impl NetworkApprovals {
    pub(crate) fn new(operation: String, requirements: ash_config::PermissionRequirements) -> Self {
        Self {
            operation,
            requirements,
            sequence: AtomicU64::new(0),
            pending: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn policy(self: &std::sync::Arc<Self>) -> network_proxy::NetworkPolicyHandle {
        network_proxy::NetworkPolicyHandle::new(NetworkApprovalPolicy(self.clone()))
    }

    pub(crate) fn requests(&self) -> Result<Vec<ProcessNetworkRequest>, ExecError> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| ExecError::Busy)?
            .values()
            .map(|pending| pending.request.clone())
            .collect())
    }

    pub(crate) fn respond(&self, request_id: &str, allow: bool) -> Result<(), ExecError> {
        exec_server_protocol::validate_id(request_id)?;
        let pending = self
            .pending
            .lock()
            .map_err(|_| ExecError::Busy)?
            .remove(request_id)
            .ok_or(ExecError::NotFound)?;
        pending
            .reply
            .send(if allow {
                NetworkDecision::Allow
            } else {
                NetworkDecision::Deny("remote network request declined".into())
            })
            .map_err(|_| ExecError::Conflict)
    }

    fn managed_decision(
        &self,
        target: &NetworkRequest,
    ) -> Result<Option<NetworkDecision>, ExecError> {
        if self.requirements.maximum_network == Some(ash_config::CommandNetworkAccess::Denied) {
            return Ok(Some(NetworkDecision::Deny(
                "network prohibited by execution host requirements".into(),
            )));
        }
        let snapshot = ash_execpolicy::ExecPolicySnapshot::new(
            ash_execpolicy::ExecPolicyDefault::Continue,
            vec![
                self.requirements
                    .layer()
                    .map_err(|_| ExecError::PermissionDenied)?,
            ],
        )
        .map_err(|_| ExecError::PermissionDenied)?;
        let review = ash_action_policy::ActionReviewRequest::new(
            ash_action_policy::ResolvedAction::new(
                ash_protocol::ActionDigest::from_canonical_bytes(target.authority().as_bytes()),
                ash_protocol::ActionKind::NetworkRequest,
                "execution-host network request",
                ash_protocol::CapabilitySet::new([ash_protocol::Capability::new(
                    ash_protocol::CapabilityKind::Network,
                    format!("{}://{}", target.protocol().as_str(), target.authority()),
                )]),
            )
            .with_network_target(
                target.protocol().as_str(),
                target.host(),
                Some(target.port()),
            ),
            ash_protocol::ActionProvenance::new(
                ash_protocol::ActionSource::BuiltInTool,
                "environment",
            ),
            ash_action_policy::SandboxCompatibility::NotApplicable {
                reason: "per-connection egress authority".into(),
            },
            ash_protocol::ActionPolicyRevision::new(snapshot.revision().as_str()),
        );
        match ash_action_policy::decide_exec_policy(&snapshot, &review)
            .map_err(|_| ExecError::PermissionDenied)?
        {
            Some(
                ash_action_policy::ExecutionDecision::Block(_)
                | ash_action_policy::ExecutionDecision::ReviseAction(_),
            ) => Ok(Some(NetworkDecision::Deny(
                "network prohibited by execution host policy".into(),
            ))),
            // Managed requirements never grant ambient access. Every permitted target still goes
            // to Core; RequireApproval cannot be converted to an unrestricted host connection.
            None
            | Some(
                ash_action_policy::ExecutionDecision::AskUser(_)
                | ash_action_policy::ExecutionDecision::RunSandboxed(_)
                | ash_action_policy::ExecutionDecision::RunUnsandboxed { .. }
                | ash_action_policy::ExecutionDecision::RunExecPolicyGranted(_)
                | ash_action_policy::ExecutionDecision::RunAutoReviewed(_)
                | ash_action_policy::ExecutionDecision::RunWithPermissionBypass(_),
            ) => Ok(None),
        }
    }
}

// A proxy can drop the future on cancellation before its next poll. Scope cleanup to the
// future's lifetime so cancelled requests cannot retain a reply or occupy a pending slot.
struct PendingWait<'a> {
    owner: &'a NetworkApprovals,
    id: String,
}
impl Drop for PendingWait<'_> {
    fn drop(&mut self) {
        self.owner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
    }
}

struct NetworkApprovalPolicy(std::sync::Arc<NetworkApprovals>);
impl NetworkPolicy for NetworkApprovalPolicy {
    fn decide(
        &self,
        target: NetworkRequest,
        cancellation: CancellationToken,
    ) -> NetworkDecisionFuture<'_> {
        let owner = &self.0;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return NetworkDecision::Deny("remote network operation cancelled".into());
            }
            match owner.managed_decision(&target) {
                Ok(Some(decision)) => return decision,
                Err(_) => {
                    return NetworkDecision::Deny(
                        "execution host network policy is unavailable".into(),
                    );
                }
                Ok(None) => {}
            }
            let sequence = owner.sequence.fetch_add(1, Ordering::Relaxed);
            let id = ash_protocol::ActionDigest::from_canonical_bytes(
                format!("{}:{sequence}", owner.operation).as_bytes(),
            )
            .as_str()
            .to_owned();
            let (reply, mut receive) = tokio::sync::oneshot::channel();
            {
                let mut pending = owner
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if pending.len() >= 64 {
                    return NetworkDecision::Deny(
                        "too many pending remote network requests".into(),
                    );
                }
                pending.insert(
                    id.clone(),
                    Pending {
                        reply,
                        request: ProcessNetworkRequest {
                            request_id: id.clone(),
                            protocol: target.protocol(),
                            host: target.host().into(),
                            port: target.port(),
                            method: target.method().map(str::to_owned),
                        },
                    },
                );
            }
            let _wait = PendingWait { owner, id };
            loop {
                if cancellation.is_cancelled() {
                    break NetworkDecision::Deny("remote network operation cancelled".into());
                }
                match receive.try_recv() {
                    Ok(decision) => break decision,
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        break NetworkDecision::Deny("remote approval caller disconnected".into());
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await
                    }
                }
            }
        })
    }
}

#[cfg(test)]
#[path = "network_approval_tests.rs"]
mod tests;
