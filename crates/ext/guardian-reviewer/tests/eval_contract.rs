use action_policy::ActionClassifier;
use action_policy::ActionPolicyEngine;
use action_policy::ActionReviewRequest;
use action_policy::ExecutionDecision;
use action_policy::ResolvedAction;
use action_policy::ReviewFailurePolicy;
use action_policy::SandboxCompatibility;
use async_utils::{CancellationSource, CancellationToken};
use protocol::ActionDigest;
use protocol::ActionKind;
use protocol::ActionPolicyRevision;
use protocol::ActionProvenance;
use protocol::ActionSource;
use protocol::AssessmentId;
use protocol::Capability;
use protocol::CapabilityKind;
use protocol::CapabilitySet;
use protocol::ClassifierAssessment;
use protocol::ClassifierRecommendation;
use protocol::ProcessInvocationKind;
use protocol::ReviewContext;
use protocol::ReviewEvidence;
use protocol::ReviewEvidenceKind;
use protocol::ReviewEvidenceTrust;
use protocol::RiskLevel;
use protocol::UserAuthorization;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::convert::Infallible;

const CASES: &str = include_str!("../evals/cases.jsonl");
const POLICY_REVISION: &str = "eval-policy-v1";

#[derive(Deserialize)]
struct EvalCase {
    schema_version: u32,
    id: String,
    category: String,
    input: EvalInput,
    expected: EvalExpected,
}

#[derive(Deserialize)]
struct EvalInput {
    action: EvalAction,
    provenance: EvalProvenance,
    sandbox: EvalSandbox,
    context: EvalContext,
}

#[derive(Deserialize)]
struct EvalAction {
    kind: EvalActionKind,
    summary: String,
    capabilities: Vec<EvalCapability>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EvalActionKind {
    LocalProcess,
    FileSystemMutation,
    NetworkRequest,
    BrowserInteraction,
    ExternalServiceMutation,
    CredentialUse,
    SystemOperation,
}

#[derive(Clone, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct EvalCapability {
    kind: CapabilityKind,
    scope: String,
}

#[derive(Deserialize)]
struct EvalProvenance {
    source: EvalActionSource,
    source_id: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EvalActionSource {
    BuiltInTool,
    Plugin,
    McpServer,
    DynamicTool,
    User,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum EvalSandbox {
    Unsupported { reason: String },
    NotApplicable { reason: String },
}

#[derive(Deserialize)]
struct EvalContext {
    user_intent: String,
    evidence: Vec<EvalEvidence>,
}

#[derive(Deserialize)]
struct EvalEvidence {
    kind: EvalEvidenceKind,
    trust: EvalEvidenceTrust,
    source: String,
    content: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EvalEvidenceKind {
    AgentMessage,
    Plan,
    PriorToolCall,
    PriorToolResult,
    PreparedAction,
    WorkspaceFile,
    EnvironmentFact,
    EnvironmentTarget,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EvalEvidenceTrust {
    TrustedUser,
    TrustedHost,
    UntrustedContent,
}

#[derive(Deserialize)]
struct EvalExpected {
    recommendation: EvalRecommendation,
    final_decision: EvalFinalDecision,
}

#[derive(Deserialize)]
#[serde(tag = "recommendation", rename_all = "snake_case")]
enum EvalRecommendation {
    Approve {
        capabilities: Vec<EvalCapability>,
        risk: RiskLevel,
        user_authorization: UserAuthorization,
        reason: String,
    },
    ReviseAction {
        maximum_capabilities: Vec<EvalCapability>,
        reason: String,
    },
    AskUser {
        reason: String,
    },
    Deny {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
enum EvalFinalDecision {
    AutoReviewed,
    ReviseAction,
    AskUser,
    Block,
}

#[derive(Clone)]
struct GoldClassifier(ClassifierAssessment);

impl ActionClassifier for GoldClassifier {
    type Error = Infallible;

    fn classify(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        Ok(self.0.clone())
    }
}

#[test]
fn seed_corpus_is_well_formed_and_covers_security_boundaries() {
    let cases = parse_cases();
    assert!(
        cases.len() >= 12,
        "the seed corpus should contain enough varied cases to catch broad regressions"
    );

    let mut ids = BTreeSet::new();
    let mut categories = BTreeSet::new();
    let mut recommendations = BTreeSet::new();
    let mut final_decisions = BTreeSet::new();
    for case in &cases {
        assert_eq!(case.schema_version, 1, "{} has an unknown schema", case.id);
        assert!(!case.id.trim().is_empty(), "case IDs must not be empty");
        assert!(
            ids.insert(case.id.as_str()),
            "duplicate evaluation case ID: {}",
            case.id
        );
        assert!(
            !case.input.action.summary.trim().is_empty(),
            "{} has no action summary",
            case.id
        );
        assert!(
            !case.input.context.user_intent.trim().is_empty(),
            "{} has no direct user intent",
            case.id
        );
        assert!(
            case.input
                .action
                .capabilities
                .iter()
                .all(|capability| !capability.scope.trim().is_empty()),
            "{} contains an empty capability scope",
            case.id
        );
        validate_recommendation(case);
        categories.insert(case.category.as_str());
        recommendations.insert(recommendation_name(&case.expected.recommendation));
        final_decisions.insert(case.expected.final_decision);
    }

    for category in [
        "benign_explicit",
        "ambiguous_authorization",
        "destructive",
        "credential_access",
        "prompt_injection",
        "policy_circumvention",
        "safer_alternative",
    ] {
        assert!(
            categories.contains(category),
            "missing category: {category}"
        );
    }
    assert_eq!(
        recommendations,
        BTreeSet::from(["approve", "ask_user", "deny", "revise_action"])
    );
    assert_eq!(
        final_decisions,
        BTreeSet::from([
            EvalFinalDecision::AutoReviewed,
            EvalFinalDecision::ReviseAction,
            EvalFinalDecision::AskUser,
            EvalFinalDecision::Block,
        ])
    );
}

#[test]
fn gold_recommendations_produce_the_expected_policy_decisions() {
    for case in parse_cases() {
        let request = case.input.to_request(&case.id);
        let assessment = ClassifierAssessment::new(
            AssessmentId::new(format!("eval:{}", case.id)),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "eval-gold-v1",
            case.expected.recommendation.to_policy(),
        );
        let engine = ActionPolicyEngine::with_no_exec_rules(
            ActionPolicyRevision::new(POLICY_REVISION),
            GoldClassifier(assessment),
            ReviewFailurePolicy::Block,
        );
        let decision = engine
            .decide(&request, &CancellationSource::new().token())
            .unwrap_or_else(|error| panic!("{} failed policy evaluation: {error}", case.id));

        assert_eq!(
            decision_name(&decision),
            case.expected.final_decision,
            "{} produced an unexpected policy decision: {decision:?}",
            case.id
        );
    }
}

fn parse_cases() -> Vec<EvalCase> {
    CASES
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("invalid eval JSONL at line {}: {error}", index + 1))
        })
        .collect()
}

fn validate_recommendation(case: &EvalCase) {
    match &case.expected.recommendation {
        EvalRecommendation::Approve {
            capabilities,
            risk,
            user_authorization,
            reason,
        } => {
            assert!(
                !capabilities.is_empty(),
                "{} approves no capability",
                case.id
            );
            assert_eq!(
                capability_keys(capabilities),
                capability_keys(&case.input.action.capabilities),
                "{} must approve the exact action capabilities",
                case.id
            );
            assert!(
                *risk != RiskLevel::Critical,
                "{} labels a critical action as approved",
                case.id
            );
            assert!(
                matches!(
                    (risk, user_authorization),
                    (
                        RiskLevel::Low | RiskLevel::Medium,
                        UserAuthorization::Explicit | UserAuthorization::Implicit
                    ) | (RiskLevel::High, UserAuthorization::Explicit)
                ),
                "{} has an approval that policy must not auto-authorize",
                case.id
            );
            assert!(
                !reason.trim().is_empty(),
                "{} has no gold rationale",
                case.id
            );
        }
        EvalRecommendation::ReviseAction {
            maximum_capabilities,
            reason,
        } => {
            assert!(
                capability_keys(maximum_capabilities)
                    .is_subset(&capability_keys(&case.input.action.capabilities)),
                "{} proposes a safer action with broader capabilities",
                case.id
            );
            assert!(
                !reason.trim().is_empty(),
                "{} has no gold rationale",
                case.id
            );
        }
        EvalRecommendation::AskUser { reason } | EvalRecommendation::Deny { reason } => {
            assert!(
                !reason.trim().is_empty(),
                "{} has no gold rationale",
                case.id
            );
        }
    }
}

fn capability_keys(capabilities: &[EvalCapability]) -> BTreeSet<(CapabilityKind, &str)> {
    capabilities
        .iter()
        .map(|capability| (capability.kind.clone(), capability.scope.as_str()))
        .collect()
}

fn recommendation_name(recommendation: &EvalRecommendation) -> &'static str {
    match recommendation {
        EvalRecommendation::Approve { .. } => "approve",
        EvalRecommendation::ReviseAction { .. } => "revise_action",
        EvalRecommendation::AskUser { .. } => "ask_user",
        EvalRecommendation::Deny { .. } => "deny",
    }
}

fn decision_name(decision: &ExecutionDecision) -> EvalFinalDecision {
    match decision {
        ExecutionDecision::RunAutoReviewed(_) => EvalFinalDecision::AutoReviewed,
        ExecutionDecision::ReviseAction(_) => EvalFinalDecision::ReviseAction,
        ExecutionDecision::AskUser(_) => EvalFinalDecision::AskUser,
        ExecutionDecision::Block(_) => EvalFinalDecision::Block,
        ExecutionDecision::RunSandboxed(_)
        | ExecutionDecision::RunUnsandboxed { .. }
        | ExecutionDecision::RunExecPolicyGranted(_)
        | ExecutionDecision::RunWithPermissionBypass(_) => {
            panic!("eval cases must reach the classifier path")
        }
    }
}

impl EvalInput {
    fn to_request(&self, case_id: &str) -> ActionReviewRequest {
        let action = ResolvedAction::new(
            ActionDigest::from_canonical_bytes(case_id.as_bytes()),
            self.action.kind.to_policy(),
            self.action.summary.clone(),
            capability_set(&self.action.capabilities),
        );
        ActionReviewRequest::new(
            action,
            ActionProvenance::new(
                self.provenance.source.to_policy(),
                self.provenance.source_id.clone(),
            ),
            self.sandbox.to_policy(),
            ActionPolicyRevision::new(POLICY_REVISION),
        )
        .with_context(self.context.to_policy())
    }
}

impl EvalActionKind {
    fn to_policy(self) -> ActionKind {
        match self {
            Self::LocalProcess => ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            Self::FileSystemMutation => ActionKind::FileSystemMutation,
            Self::NetworkRequest => ActionKind::NetworkRequest,
            Self::BrowserInteraction => ActionKind::BrowserInteraction,
            Self::ExternalServiceMutation => ActionKind::ExternalServiceMutation,
            Self::CredentialUse => ActionKind::CredentialUse,
            Self::SystemOperation => ActionKind::SystemOperation,
        }
    }
}

impl EvalActionSource {
    fn to_policy(self) -> ActionSource {
        match self {
            Self::BuiltInTool => ActionSource::BuiltInTool,
            Self::Plugin => ActionSource::Plugin,
            Self::McpServer => ActionSource::McpServer,
            Self::DynamicTool => ActionSource::DynamicTool,
            Self::User => ActionSource::User,
        }
    }
}

impl EvalSandbox {
    fn to_policy(&self) -> SandboxCompatibility {
        match self {
            Self::Unsupported { reason } => SandboxCompatibility::Unsupported {
                reason: reason.clone(),
            },
            Self::NotApplicable { reason } => SandboxCompatibility::NotApplicable {
                reason: reason.clone(),
            },
        }
    }
}

impl EvalContext {
    fn to_policy(&self) -> ReviewContext {
        ReviewContext::new(
            self.user_intent.clone(),
            self.evidence.iter().map(EvalEvidence::to_policy),
        )
    }
}

impl EvalEvidence {
    fn to_policy(&self) -> ReviewEvidence {
        ReviewEvidence::new(
            self.kind.to_policy(),
            self.trust.to_policy(),
            self.source.clone(),
            self.content.clone(),
        )
    }
}

impl EvalEvidenceKind {
    fn to_policy(self) -> ReviewEvidenceKind {
        match self {
            Self::AgentMessage => ReviewEvidenceKind::AgentMessage,
            Self::Plan => ReviewEvidenceKind::Plan,
            Self::PriorToolCall => ReviewEvidenceKind::PriorToolCall,
            Self::PriorToolResult => ReviewEvidenceKind::PriorToolResult,
            Self::PreparedAction => ReviewEvidenceKind::PreparedAction,
            Self::WorkspaceFile => ReviewEvidenceKind::DirectoryFile,
            Self::EnvironmentFact => ReviewEvidenceKind::EnvironmentFact,
            Self::EnvironmentTarget => ReviewEvidenceKind::EnvironmentTarget,
        }
    }
}

impl EvalEvidenceTrust {
    fn to_policy(self) -> ReviewEvidenceTrust {
        match self {
            Self::TrustedUser => ReviewEvidenceTrust::TrustedUser,
            Self::TrustedHost => ReviewEvidenceTrust::TrustedHost,
            Self::UntrustedContent => ReviewEvidenceTrust::UntrustedContent,
        }
    }
}

impl EvalRecommendation {
    fn to_policy(&self) -> ClassifierRecommendation {
        match self {
            Self::Approve {
                capabilities,
                risk,
                user_authorization,
                reason,
            } => ClassifierRecommendation::Approve {
                capabilities: capability_set(capabilities),
                risk: *risk,
                user_authorization: *user_authorization,
                reason: reason.clone(),
            },
            Self::ReviseAction {
                maximum_capabilities,
                reason,
            } => ClassifierRecommendation::ReviseAction {
                maximum_capabilities: capability_set(maximum_capabilities),
                reason: reason.clone(),
            },
            Self::AskUser { reason } => ClassifierRecommendation::AskUser {
                reason: reason.clone(),
            },
            Self::Deny { reason } => ClassifierRecommendation::Deny {
                reason: reason.clone(),
            },
        }
    }
}

fn capability_set(capabilities: &[EvalCapability]) -> CapabilitySet {
    CapabilitySet::new(
        capabilities
            .iter()
            .map(|capability| Capability::new(capability.kind.clone(), capability.scope.clone())),
    )
}
