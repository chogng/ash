use crate::ActionClassifier;
use crate::ActionReviewRequest;
use crate::ApprovalRequest;
use crate::AutoReviewGrant;
use crate::BlockReason;
use crate::DeterministicPolicyGrant;
use crate::ExecutionDecision;
use crate::PolicyError;
use crate::ReviewFailurePolicy;
use crate::SaferActionRequest;
use crate::SandboxCompatibility;
use crate::UserAllowlist;
use ash_async_utils::CancellationToken;
use ash_execpolicy::ExecPolicyCapability;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyEvaluation;
use ash_execpolicy::ExecPolicySnapshot;
use ash_execpolicy::ExecPolicySubject;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionReviewPhase;
use ash_protocol::ClassifierAssessment;
use ash_protocol::ClassifierRecommendation;
use ash_protocol::RiskLevel;
use ash_protocol::UserAuthorization;

/// Final action authority that composes deterministic rules, grants, sandboxing, and review.
pub struct ActionPolicyEngine<C> {
    revision: ActionPolicyRevision,
    exec_policy: ExecPolicySnapshot,
    classifier: C,
    user_allowlist: UserAllowlist,
    review_failure_policy: ReviewFailurePolicy,
}

impl<C: ActionClassifier> ActionPolicyEngine<C> {
    pub fn new(
        revision: ActionPolicyRevision,
        exec_policy: ExecPolicySnapshot,
        classifier: C,
        review_failure_policy: ReviewFailurePolicy,
    ) -> Self {
        Self {
            revision,
            exec_policy,
            classifier,
            user_allowlist: UserAllowlist::default(),
            review_failure_policy,
        }
    }

    /// Creates an action authority whose deterministic layer has no configured rules.
    ///
    /// This is intended for review-only adapters and tests. Product policy composition should
    /// pass its real immutable [`ExecPolicySnapshot`] to [`Self::new`].
    pub fn with_no_exec_rules(
        revision: ActionPolicyRevision,
        classifier: C,
        review_failure_policy: ReviewFailurePolicy,
    ) -> Self {
        Self::new(
            revision,
            ExecPolicySnapshot::permissive_empty(),
            classifier,
            review_failure_policy,
        )
    }

    /// Installs exact user-authorized actions that may run without sandbox enforcement.
    pub fn with_user_allowlist(mut self, allowlist: UserAllowlist) -> Self {
        self.user_allowlist = allowlist;
        self
    }

    pub fn revision(&self) -> &ActionPolicyRevision {
        &self.revision
    }

    pub fn exec_policy_revision(&self) -> &ash_execpolicy::ExecPolicyRevision {
        self.exec_policy.revision()
    }

    pub fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, PolicyError> {
        self.ensure_revision(request)?;
        let evaluation = self.evaluate_exec_policy(request);
        if let Some(decision) = self.apply_exec_policy(request, &evaluation)? {
            return Ok(decision);
        }
        if let Some(grant) = self.user_allowlist.matching_grant(request) {
            return Ok(ExecutionDecision::RunUnsandboxed {
                grant_id: grant.id().clone(),
            });
        }
        if matches!(request.phase(), ActionReviewPhase::Initial)
            && let SandboxCompatibility::Supported(policy) = request.sandbox()
        {
            return Ok(ExecutionDecision::RunSandboxed(*policy));
        }

        let assessment = match self.classifier.classify(request, cancellation) {
            Ok(assessment) => assessment,
            Err(error) => return Ok(self.review_failure_decision(request, error.to_string())),
        };
        self.apply_assessment(request, assessment)
    }

    /// Applies classifier review after another authoritative policy already returned `AskUser`.
    ///
    /// This entry point intentionally skips sandbox routing and deterministic evaluation. Hosts
    /// may call it only after the same exact request has passed their authoritative action policy.
    pub fn review_after_authoritative_ask_user(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, PolicyError> {
        self.ensure_revision(request)?;
        let assessment = match self.classifier.classify(request, cancellation) {
            Ok(assessment) => assessment,
            Err(error) => return Ok(self.review_failure_decision(request, error.to_string())),
        };
        self.apply_assessment(request, assessment)
    }

    fn ensure_revision(&self, request: &ActionReviewRequest) -> Result<(), PolicyError> {
        if self.revision == *request.action_policy_revision() {
            Ok(())
        } else {
            Err(PolicyError::RevisionMismatch {
                engine: self.revision.clone(),
                request: request.action_policy_revision().clone(),
            })
        }
    }

    fn evaluate_exec_policy(&self, request: &ActionReviewRequest) -> ExecPolicyEvaluation {
        let capabilities = request
            .action()
            .required_capabilities()
            .iter()
            .map(|capability| {
                ExecPolicyCapability::new(
                    crate::action::capability_policy_name(capability.kind()),
                    capability.scope(),
                )
            });
        let subject = ExecPolicySubject::new(
            request.action().digest().as_str(),
            crate::action::action_policy_kind(request.action().kind()),
            crate::action::action_source_policy_name(request.provenance().source()),
            request.provenance().source_id(),
            capabilities,
            request.action().command(),
            request.action().network_target(),
        );
        self.exec_policy.evaluate(&subject)
    }

    fn apply_exec_policy(
        &self,
        request: &ActionReviewRequest,
        evaluation: &ExecPolicyEvaluation,
    ) -> Result<Option<ExecutionDecision>, PolicyError> {
        let decision = match evaluation.effect() {
            ExecPolicyEffect::Continue => return Ok(None),
            ExecPolicyEffect::AllowUnsandboxed => {
                let source = evaluation
                    .source()
                    .cloned()
                    .ok_or(PolicyError::ExecPolicyAuthorityMissing)?;
                ExecutionDecision::RunExecPolicyGranted(DeterministicPolicyGrant::new(
                    source,
                    evaluation.revision().clone(),
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    request.action_policy_revision().clone(),
                ))
            }
            ExecPolicyEffect::RequireApproval => ExecutionDecision::AskUser(ApprovalRequest::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                "a deterministic execution-policy rule requires user approval",
            )),
            ExecPolicyEffect::RequireSandbox => {
                let source = evaluation
                    .source()
                    .cloned()
                    .ok_or(PolicyError::ExecPolicyAuthorityMissing)?;
                match (request.phase(), request.sandbox()) {
                    (ActionReviewPhase::Initial, SandboxCompatibility::Supported(policy)) => {
                        ExecutionDecision::RunSandboxed(*policy)
                    }
                    (ActionReviewPhase::SandboxDenial(denial), _) => {
                        ExecutionDecision::Block(BlockReason::SandboxRequiredButUnavailable {
                            source,
                            reason: format!(
                                "the required sandbox denied the action: {}",
                                denial.reason()
                            ),
                        })
                    }
                    (
                        ActionReviewPhase::Initial,
                        SandboxCompatibility::Unsupported { reason }
                        | SandboxCompatibility::NotApplicable { reason },
                    ) => ExecutionDecision::Block(BlockReason::SandboxRequiredButUnavailable {
                        source,
                        reason: reason.clone(),
                    }),
                }
            }
            ExecPolicyEffect::Deny(reason) => {
                ExecutionDecision::Block(BlockReason::DeterministicRule {
                    source: evaluation.source().cloned(),
                    reason: reason.clone(),
                })
            }
        };
        Ok(Some(decision))
    }

    fn apply_assessment(
        &self,
        request: &ActionReviewRequest,
        assessment: ClassifierAssessment,
    ) -> Result<ExecutionDecision, PolicyError> {
        if assessment.action_digest() != request.action().digest()
            || assessment.action_policy_revision() != request.action_policy_revision()
        {
            return Err(PolicyError::ClassifierBindingMismatch);
        }
        if let Err(error) = crate::validate_recommendation(
            assessment.recommendation(),
            request.action().required_capabilities(),
        ) {
            return Ok(ExecutionDecision::Block(BlockReason::ReviewFailed {
                reason: error.to_string(),
            }));
        }
        let decision = match assessment.recommendation() {
            ClassifierRecommendation::Approve {
                capabilities,
                risk,
                user_authorization,
                reason,
            } => self.automatic_approval_decision(
                request,
                &assessment,
                capabilities,
                *risk,
                *user_authorization,
                reason,
            ),
            ClassifierRecommendation::ReviseAction {
                maximum_capabilities,
                reason,
            } => ExecutionDecision::ReviseAction(SaferActionRequest::new(
                assessment.assessment_id().clone(),
                maximum_capabilities.clone(),
                reason,
            )),
            ClassifierRecommendation::AskUser { reason } => {
                ExecutionDecision::AskUser(ApprovalRequest::new(
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    reason,
                ))
            }
            ClassifierRecommendation::Deny { reason } => {
                ExecutionDecision::Block(BlockReason::ReviewerDenied {
                    assessment_id: assessment.assessment_id().clone(),
                    reason: reason.clone(),
                })
            }
        };
        Ok(decision)
    }

    fn automatic_approval_decision(
        &self,
        request: &ActionReviewRequest,
        assessment: &ClassifierAssessment,
        capabilities: &ash_protocol::CapabilitySet,
        risk: RiskLevel,
        user_authorization: UserAuthorization,
        reason: &str,
    ) -> ExecutionDecision {
        if risk == RiskLevel::Critical {
            return ExecutionDecision::Block(BlockReason::CriticalRisk {
                assessment_id: assessment.assessment_id().clone(),
                reason: reason.to_owned(),
            });
        }
        let authorized = matches!(
            (risk, user_authorization),
            (
                RiskLevel::Low | RiskLevel::Medium,
                UserAuthorization::Explicit | UserAuthorization::Implicit
            ) | (RiskLevel::High, UserAuthorization::Explicit)
        );
        if !authorized {
            return ExecutionDecision::AskUser(ApprovalRequest::new(
                request.action().digest().clone(),
                capabilities.clone(),
                format!("automatic review needs explicit user authorization: {reason}"),
            ));
        }
        ExecutionDecision::RunAutoReviewed(AutoReviewGrant::new(
            assessment.assessment_id().clone(),
            request.action().digest().clone(),
            capabilities.clone(),
            request.action_policy_revision().clone(),
        ))
    }

    fn review_failure_decision(
        &self,
        request: &ActionReviewRequest,
        reason: String,
    ) -> ExecutionDecision {
        match self.review_failure_policy {
            ReviewFailurePolicy::Block => {
                ExecutionDecision::Block(BlockReason::ReviewFailed { reason })
            }
            ReviewFailurePolicy::AskUser => ExecutionDecision::AskUser(ApprovalRequest::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                format!("automatic review was unavailable: {reason}"),
            )),
        }
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
