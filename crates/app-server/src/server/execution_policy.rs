//! Common execution constraints applied before Core selects an approval mode.
//! Configuration remains authoritative in ConfigStore and the resolved environment snapshot.

use super::AppServer;
use super::environment_runtime::EnvRuntimeConfig;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;
use ash_config::ConfigStore;
use ash_execpolicy::ExecPolicySnapshot;
use core_api::ActionPolicyService;
use core_api::CoreError;
use std::sync::Arc;
use std::sync::RwLock;

impl AppServer {
    pub(super) fn shared_action_policy(
        &self,
        owner: Arc<dyn ActionPolicyService>,
    ) -> Arc<dyn ActionPolicyService> {
        Arc::new(SharedExecutionPolicy {
            owner,
            config: self.config.clone(),
            environment: Arc::clone(&self.env_config),
            runtime: Some(Arc::downgrade(&self.env_runtime)),
        })
    }
}

struct SharedExecutionPolicy {
    owner: Arc<dyn ActionPolicyService>,
    config: Option<Arc<ConfigStore>>,
    environment: Arc<RwLock<EnvRuntimeConfig>>,
    // EnvRuntime owns its executor policy; a strong reference here would retain the entire host.
    runtime: Option<std::sync::Weak<RwLock<super::environment_runtime::EnvRuntime>>>,
}

impl SharedExecutionPolicy {
    fn approval_available(&self, request: &ActionReviewRequest) -> Result<bool, CoreError> {
        let environment = self
            .environment
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let user = self.config.as_ref().map(|store| store.committed_snapshot());
        let controls = user
            .as_ref()
            .map(|snapshot| &snapshot.values.permissions.approval_prompts)
            .unwrap_or_else(|| environment.tools.approval_controls());
        let managed = &environment
            .tools
            .requirements
            .as_ref()
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .values;
        Ok(controls.allows(
            request.action().kind(),
            request.provenance().source(),
            request.phase(),
        ) && managed.approval_prompts.as_ref().is_none_or(|controls| {
            controls.allows(
                request.action().kind(),
                request.provenance().source(),
                request.phase(),
            )
        }))
    }

    fn rules(&self) -> Result<ExecPolicySnapshot, CoreError> {
        let user = self.config.as_ref().map(|store| store.committed_snapshot());
        self.environment
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tools
            .common_policy_snapshot(user.as_ref().map(|snapshot| &snapshot.values.exec_policy))
            .map_err(|error| CoreError::Policy(error.to_string()))
    }
}

impl ActionPolicyService for SharedExecutionPolicy {
    fn revision(&self) -> String {
        let user = self.config.as_ref().map(|store| store.committed_snapshot());
        let permissions = self
            .environment
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tools
            .permission_revision(user.as_ref().map(|snapshot| &snapshot.values));
        match self.rules() {
            Ok(rules) => format!(
                "{}:shared-rules={}:permissions={permissions}",
                self.owner.revision(),
                rules.revision()
            ),
            Err(error) => format!(
                "{}:invalid-shared-rules={error}:permissions={permissions}",
                self.owner.revision()
            ),
        }
    }

    fn revision_for(&self, provenance: &ash_protocol::ActionProvenance) -> String {
        self.owner.revision_for(provenance)
    }

    fn permission_context(
        &self,
        session: &ash_protocol::SessionId,
        thread: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError> {
        let environment = self
            .environment
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let requirements = environment
            .tools
            .requirements
            .as_ref()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let values = self
            .config
            .as_ref()
            .map(|config| config.committed_snapshot().values);
        let profile = environment
            .tools
            .profile()
            .and_then(|profile| requirements.values.constrain(profile))
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let mut roots = Vec::new();
        let mut requested = Vec::new();
        if let Some(runtime) = self.runtime.as_ref().and_then(std::sync::Weak::upgrade) {
            let runtime = runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            requested = runtime.dir_grants.requested_context(session, thread);
            for grant in runtime.selected_grant.iter().chain(runtime.dirs.values()) {
                if grant.is_active() {
                    roots.push(serde_json::json!({
                    "environment": grant.dir().env().as_str(), "path": grant.dir().canonical_path(),
                    "permissions": grant.permissions(), "source": format!("{:?}", grant.source()) }));
                }
            }
            for entry in runtime.dir_grants.list(session).into_iter().take(32) {
                roots.push(serde_json::json!({"environment": entry.dir().env().as_str(), "path": entry.dir().canonical_path(), "permissions": entry.permissions(), "source": "session"}));
            }
            if let Some(root) = runtime
                .dir_grants
                .thread_scope(thread, ash_file_access::Permission::ReadFiles)
                .map_err(|error| CoreError::Policy(error.to_string()))?
            {
                roots.push(serde_json::json!({"environment": root.primary().dir().env().as_str(), "path": root.primary().dir().canonical_path(), "permissions": root.permissions(), "source": "thread"}));
            }
        }
        let rules_revision = environment
            .tools
            .common_policy_snapshot(values.as_ref().map(|values| &values.exec_policy))
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .revision()
            .as_str()
            .to_owned();
        let fact = serde_json::json!({"profile": profile.name, "fileSystem": profile.file_system,
            "hostRead": profile.host_read, "network": profile.network, "fileOperations": profile.file_operations, "scope": format!("{:?}", profile.scope),
            "pathRules": profile.paths.iter().take(64).collect::<Vec<_>>(), "omittedPathRules": profile.paths.len().saturating_sub(64),
            "directoryGrants": roots, "temporaryGrants": requested, "approvalPrompts": environment.tools.approval_controls(), "managedSource": requirements.source, "allowedApprovalModes": requirements.values.allowed_approval_modes,
            "executionRulesRevision": rules_revision});
        let mut evidence = self.owner.permission_context(session, thread)?;
        evidence.push(ash_protocol::ReviewEvidence::new(
            ash_protocol::ReviewEvidenceKind::EnvironmentFact,
            ash_protocol::ReviewEvidenceTrust::TrustedHost,
            "effective-permissions",
            fact.to_string(),
        ));
        Ok(evidence)
    }

    fn check_approval_mode(&self, mode: ash_protocol::ApprovalMode) -> Result<(), CoreError> {
        self.environment
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tools
            .requirements
            .as_ref()
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .values
            .check_approval_mode(mode)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        self.owner.check_approval_mode(mode)
    }

    fn approval_decisions(
        &self,
        request: &ActionReviewRequest,
    ) -> Vec<ash_protocol::ActionApprovalDecision> {
        use ash_protocol::ActionApprovalDecision as Decision;
        let mut decisions = vec![Decision::Decline, Decision::ApproveOnce];
        if matches!(request.phase(), ash_protocol::ActionReviewPhase::Initial)
            && self
                .rules()
                .ok()
                .and_then(|rules| ash_action_policy::decide_exec_policy(&rules, request).ok())
                .flatten()
                .is_none()
        {
            decisions.push(Decision::ApproveForSession);
            if self.config.is_some()
                && request.action().kind() != &ash_protocol::ActionKind::NetworkRequest
            {
                decisions.push(Decision::ApproveAndSaveRule);
            }
        }
        decisions
    }

    fn record_approval(
        &self,
        context: &core_api::ActionPolicyContext<'_>,
        request: &ActionReviewRequest,
        decision: ash_protocol::ActionApprovalDecision,
    ) -> Result<core_api::ApprovalRecordEffect, CoreError> {
        use ash_protocol::ActionApprovalDecision as Decision;
        if !self.approval_decisions(request).contains(&decision) {
            return Err(CoreError::Policy(
                "approval decision is no longer available".into(),
            ));
        }
        match decision {
            Decision::ApproveForSession => {
                let mut approval = ash_core::durable_approval_request(
                    request,
                    &ash_action_policy::ApprovalRequest::new(
                        request.action().digest().clone(),
                        request.action().required_capabilities().clone(),
                        "exact session action",
                    ),
                )?;
                approval.policy_revision = self.revision();
                self.runtime
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade)
                    .ok_or_else(|| CoreError::Policy("session permissions are unavailable".into()))?
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .dir_grants
                    .remember_approval(
                        context.session.clone(),
                        request.provenance().clone(),
                        approval,
                    )
                    .map_err(CoreError::Policy)?;
                Ok(core_api::ApprovalRecordEffect::Recorded)
            }
            Decision::ApproveAndSaveRule => {
                let store = self.config.as_ref().ok_or_else(|| {
                    CoreError::Policy("permission rule persistence is unavailable".into())
                })?;
                let digest = request.action().digest().as_str();
                let source = serde_json::to_value(request.provenance().source())
                    .map_err(|error| CoreError::Policy(error.to_string()))?;
                let snapshot = store
                    .read_snapshot()
                    .map_err(|error| CoreError::Policy(error.to_string()))?;
                store
                    .apply(ash_config::ConfigCommandRequest {
                        command_id: ash_protocol::CommandId::new(format!(
                            "approve-rule:{}:{digest}:{}",
                            context.turn,
                            snapshot.revision.get()
                        ))
                        .map_err(|error| CoreError::Policy(error.to_string()))?,
                        expected_revision: snapshot.revision,
                        command: ash_config::UserConfigCommand::UpsertExecPolicyRule {
                            rule: ash_execpolicy::ExecPolicyRule::new(
                                ash_execpolicy::ExecPolicyRuleId::new(format!(
                                    "approved-action:{digest}"
                                )),
                                ash_execpolicy::ExecPolicySelector::all([
                                    ash_execpolicy::ExecPolicySelector::ActionDigest {
                                        digest: digest.into(),
                                    },
                                    ash_execpolicy::ExecPolicySelector::source(
                                        source.as_str().map(str::to_owned),
                                        Some(request.provenance().source_id().into()),
                                    ),
                                ]),
                                ash_execpolicy::ExecPolicyEffect::AllowUnsandboxed,
                            ),
                        },
                    })
                    .map_err(|error| {
                        CoreError::Policy(format!("cannot save approved action: {error:?}"))
                    })?;
                Ok(core_api::ApprovalRecordEffect::PolicyChanged)
            }
            Decision::ApproveOnce | Decision::Decline => {
                Ok(core_api::ApprovalRecordEffect::Recorded)
            }
        }
    }

    fn validate_execution(
        &self,
        request: &ActionReviewRequest,
        authority: ash_protocol::ToolExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError> {
        if let Some(store) = &self.config
            && !self
                .environment
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .tools
                .matches_runtime_permissions(&store.committed_snapshot().values)
        {
            return Err(CoreError::Policy(
                "permission configuration is pending runtime reconciliation".into(),
            ));
        }
        if matches!(
            request.action().kind(),
            ash_protocol::ActionKind::LocalProcess(_)
        ) && request.provenance().source_id() != "environment"
            && let Some(store) = &self.config
            && !self
                .environment
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .tools
                .networking_matches(&store.committed_snapshot().values.exec_policy)
        {
            return Err(CoreError::Policy(
                "network permission policy is pending process runtime reconciliation".into(),
            ));
        }
        match ash_action_policy::decide_exec_policy(&self.rules()?, request)
            .map_err(|error| CoreError::Policy(error.to_string()))?
        {
            Some(ExecutionDecision::Block(reason)) => {
                return Err(CoreError::Policy(format!(
                    "execution is prohibited: {reason:?}"
                )));
            }
            Some(ExecutionDecision::RunSandboxed(_))
                if authority != ash_protocol::ToolExecutionAuthority::Sandboxed =>
            {
                return Err(CoreError::Policy(
                    "execution requires its configured sandbox".into(),
                ));
            }
            _ => {}
        }
        if matches!(
            authority,
            ash_protocol::ToolExecutionAuthority::ApprovedOnce { .. }
        ) && !self.approval_available(request)?
        {
            return Err(CoreError::Policy(
                "approval is no longer available for this operation".into(),
            ));
        }
        self.owner
            .validate_execution(request, authority, cancellation)
    }

    fn decide_in_context(
        &self,
        context: &core_api::ActionPolicyContext<'_>,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let decision = self.decide(request, cancellation)?;
        if !matches!(decision, ExecutionDecision::AskUser(_)) {
            return Ok(decision);
        }
        if ash_action_policy::decide_exec_policy(&self.rules()?, request)
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .is_some()
        {
            return Ok(decision);
        }
        if let Some(runtime) = self.runtime.as_ref().and_then(std::sync::Weak::upgrade) {
            let mut approval = ash_core::durable_approval_request(
                request,
                &ash_action_policy::ApprovalRequest::new(
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    "exact session action",
                ),
            )?;
            approval.policy_revision = self.revision();
            if runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .dir_grants
                .has_approval(context.session, request.provenance(), &approval)
            {
                return Ok(ExecutionDecision::RunUnsandboxed {
                    grant_id: ash_action_policy::GrantId::new("approved-session-action"),
                });
            }
        }
        if let Some(target) = request.action().network_target()
            && request.action().kind() == &ash_protocol::ActionKind::NetworkRequest
            && matches!(
                request.provenance().source_id(),
                "shell-command" | "shell-session"
            )
            && let Some(runtime) = self.runtime.as_ref().and_then(std::sync::Weak::upgrade)
        {
            let environment = self
                .environment
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let requirements = &environment
                .tools
                .requirements
                .as_ref()
                .map_err(|error| CoreError::Policy(error.to_string()))?
                .values;
            let profile = environment
                .tools
                .profile()
                .map_err(|error| CoreError::Policy(error.to_string()))?;
            if requirements.maximum_network == Some(ash_config::CommandNetworkAccess::Denied)
                || profile.scope == ash_config::PermissionProfileScope::AllOperations
                    && profile.network == ash_config::CommandNetworkAccess::Denied
            {
                return Ok(ExecutionDecision::Block(
                    ash_action_policy::BlockReason::DeterministicRule {
                        source: None,
                        reason: "network access exceeds the configured permission ceiling".into(),
                    },
                ));
            }
            if runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .dir_grants
                .requested_network(context.session, context.thread, context.turn, target.host())
            {
                return Ok(ExecutionDecision::RunUnsandboxed {
                    grant_id: ash_action_policy::GrantId::new("requested-network-permission"),
                });
            }
        }
        self.owner.decide_in_context(context, request, cancellation)
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if request.action().kind() == &ash_protocol::ActionKind::NetworkRequest {
            let environment = self
                .environment
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let requirements = &environment
                .tools
                .requirements
                .as_ref()
                .map_err(|error| CoreError::Policy(error.to_string()))?
                .values;
            let profile = environment
                .tools
                .profile()
                .map_err(|error| CoreError::Policy(error.to_string()))?;
            if requirements.maximum_network == Some(ash_config::CommandNetworkAccess::Denied)
                || profile.scope == ash_config::PermissionProfileScope::AllOperations
                    && profile.network == ash_config::CommandNetworkAccess::Denied
            {
                return Ok(ExecutionDecision::Block(
                    ash_action_policy::BlockReason::DeterministicRule {
                        source: None,
                        reason: "network access exceeds the configured permission ceiling".into(),
                    },
                ));
            }
        }
        let shared = ash_action_policy::decide_exec_policy(&self.rules()?, request)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        if matches!(shared, Some(ExecutionDecision::Block(_))) {
            return Ok(shared.expect("matched deterministic block"));
        }
        // A domain validates its exact capabilities and resource bindings even when a user rule
        // permits execution. Its hard denial and requested revision cannot be bypassed here.
        let owned = self.owner.decide(request, cancellation)?;
        if matches!(
            owned,
            ExecutionDecision::Block(_) | ExecutionDecision::ReviseAction(_)
        ) {
            return Ok(owned);
        }
        let decision = shared.unwrap_or(owned);
        if matches!(decision, ExecutionDecision::AskUser(_)) && !self.approval_available(request)? {
            return Ok(ExecutionDecision::Block(
                ash_action_policy::BlockReason::DeterministicRule {
                    source: None,
                    reason: "approval prompts are disabled for this operation".into(),
                },
            ));
        }
        Ok(decision)
    }

    fn review_approval(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<Option<ExecutionDecision>, CoreError> {
        self.owner.review_approval(request, cancellation)
    }
}

#[cfg(test)]
#[path = "execution_policy_tests.rs"]
mod tests;
