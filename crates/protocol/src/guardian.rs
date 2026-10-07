//! Shared Guardian facts: reviewed action identity, scoped capabilities, evidence, and advisory assessments.
//!
//! Hosts label evidence and bind each assessment to the exact action and policy revision. These data
//! types do not execute tools, select reviewers, apply permission rules, or grant execution authority.
//! Sandbox policies and materialized rule-engine input remain owned by action-policy.

use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fmt;

/// Host-resolved authority categories required by an action, independent of any reviewer implementation.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    FileRead,
    FileWrite,
    ProcessSpawn,
    Network,
    CredentialUse,
    ExternalMutation,
    SystemConfiguration,
    UserInterface,
}

/// One scoped authority needed by a resolved action.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Capability {
    kind: CapabilityKind,
    scope: String,
}

impl Capability {
    pub fn new(kind: CapabilityKind, scope: impl Into<String>) -> Self {
        Self {
            kind,
            scope: scope.into(),
        }
    }

    pub fn kind(&self) -> &CapabilityKind {
        &self.kind
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }
}

/// Canonically ordered capabilities used for exact grant and recommendation comparisons.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CapabilitySet(BTreeSet<Capability>);

impl CapabilitySet {
    pub fn new(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self(capabilities.into_iter().collect())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn is_subset(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Capability> {
        self.0.iter()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessInvocationKind {
    Direct,
    Shell,
}

/// Action category recorded by the host; the policy engine maps it to its rule language.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ActionKind {
    LocalProcess(ProcessInvocationKind),
    FileSystemMutation,
    NetworkRequest,
    BrowserInteraction,
    ExternalServiceMutation,
    CredentialUse,
    SystemOperation,
}

/// Origin of the resolved action, assigned by the host rather than inferred by the model.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSource {
    BuiltInTool,
    Plugin,
    McpServer,
    DynamicTool,
    User,
}

/// Trusted provenance assigned by the host after resolving the exact tool binding.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ActionProvenance {
    source: ActionSource,
    source_id: String,
}

impl ActionProvenance {
    pub fn new(source: ActionSource, source_id: impl Into<String>) -> Self {
        Self {
            source,
            source_id: source_id.into(),
        }
    }

    pub fn source(&self) -> &ActionSource {
        &self.source
    }

    pub fn source_id(&self) -> &str {
        &self.source_id
    }
}

/// SHA-256 identity of the host-canonical action, including all security-relevant fields.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ActionDigest(String);

impl ActionDigest {
    pub fn from_canonical_bytes(bytes: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(bytes.as_ref());
        Self(format!("{digest:x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ActionDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Revision of the complete action-policy environment used for one review.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ActionPolicyRevision(String);

impl ActionPolicyRevision {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Bounded evidence from a completed sandbox attempt that was denied by enforcement.
///
/// The host is expected to retain only the output needed for review, remove secrets, and create
/// this value only after distinguishing sandbox enforcement from an ordinary command failure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SandboxDenialEvidence {
    reason: String,
    output: String,
}

impl SandboxDenialEvidence {
    pub fn new(reason: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            output: output.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn output(&self) -> &str {
        &self.output
    }
}

/// Identifies whether review happens before execution or after a confirmed sandbox denial.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ActionReviewPhase {
    Initial,
    SandboxDenial(SandboxDenialEvidence),
}

/// Trust assigned by the host to one piece of review evidence.
///
/// Implementations should mark only direct user instructions and host-owned metadata as trusted.
/// Repository contents, tool output, and Agent-authored text remain untrusted even when they were
/// read through a trusted local adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceTrust {
    TrustedUser,
    TrustedHost,
    UntrustedContent,
}

/// Source category for bounded evidence supplied to an action reviewer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceKind {
    UserMessage,
    UserGoal,
    UserAnswer,
    Delegation,
    AgentMessage,
    Plan,
    PriorToolCall,
    PriorToolResult,
    PreparedAction,
    DirectoryFile,
    EnvironmentFact,
    EnvironmentTarget,
}

/// One bounded, host-labeled observation relevant to the proposed action.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReviewEvidence {
    kind: ReviewEvidenceKind,
    trust: ReviewEvidenceTrust,
    source: String,
    content: String,
}

impl ReviewEvidence {
    pub fn new(
        kind: ReviewEvidenceKind,
        trust: ReviewEvidenceTrust,
        source: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            trust,
            source: source.into(),
            content: content.into(),
        }
    }

    pub fn kind(&self) -> ReviewEvidenceKind {
        self.kind
    }

    pub fn trust(&self) -> ReviewEvidenceTrust {
        self.trust
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn content(&self) -> &str {
        &self.content
    }
}

/// Compact user intent and evidence visible to the action reviewer.
///
/// Hosts should include only the smallest transcript slice needed to relate an action to the
/// user's request. Secrets and credentials must be removed before constructing this value.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct ReviewContext {
    user_intent: String,
    evidence: Vec<ReviewEvidence>,
    omitted_evidence: usize,
}

impl ReviewContext {
    pub fn new(
        user_intent: impl Into<String>,
        evidence: impl IntoIterator<Item = ReviewEvidence>,
    ) -> Self {
        Self {
            user_intent: user_intent.into(),
            evidence: evidence.into_iter().collect(),
            omitted_evidence: 0,
        }
    }

    pub fn user_intent(&self) -> &str {
        &self.user_intent
    }

    pub fn evidence(&self) -> &[ReviewEvidence] {
        &self.evidence
    }

    /// Records whole evidence entries omitted by request budgeting; user authorization is never
    /// shortened or omitted to make an advisory request fit.
    pub fn with_omitted_evidence(mut self, count: usize) -> Self {
        self.omitted_evidence = count;
        self
    }

    pub fn omitted_evidence(&self) -> usize {
        self.omitted_evidence
    }
}

/// Host-visible identity of one exact classifier assessment.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AssessmentId(String);

impl AssessmentId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Derives an assessment identity from its immutable request binding and canonical reviewer
    /// output.
    pub fn from_response(
        action_digest: &ActionDigest,
        action_policy_revision: &ActionPolicyRevision,
        review_protocol_revision: &str,
        response: impl AsRef<[u8]>,
    ) -> Self {
        let mut digest = Sha256::new();
        digest.update(action_digest.as_str().as_bytes());
        digest.update([0]);
        digest.update(action_policy_revision.as_str().as_bytes());
        digest.update([0]);
        digest.update(review_protocol_revision.as_bytes());
        digest.update([0]);
        digest.update(response.as_ref());
        let digest = digest.finalize();
        Self(format!("{digest:x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Consequence level assigned to an action by the advisory reviewer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

/// How directly the current user request authorizes the proposed action.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserAuthorization {
    Explicit,
    Implicit,
    Absent,
    Ambiguous,
}

/// Advisory approval, revision, question, or denial; an approval suggestion is not an execution grant.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "recommendation", rename_all = "snake_case")]
pub enum ClassifierRecommendation {
    Approve {
        capabilities: CapabilitySet,
        risk: RiskLevel,
        user_authorization: UserAuthorization,
        reason: String,
    },
    ReviseAction {
        maximum_capabilities: CapabilitySet,
        reason: String,
    },
    AskUser {
        reason: String,
    },
    Deny {
        reason: String,
    },
}

/// Advisory classifier output bound by the host to the reviewed action and policy revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassifierAssessment {
    assessment_id: AssessmentId,
    action_digest: ActionDigest,
    action_policy_revision: ActionPolicyRevision,
    review_protocol_revision: String,
    recommendation: ClassifierRecommendation,
}

impl ClassifierAssessment {
    /// Creates an advisory assessment while binding it to host-owned identities.
    ///
    /// Classifier implementations must copy these identities from the request they reviewed.
    pub fn new(
        assessment_id: AssessmentId,
        action_digest: ActionDigest,
        action_policy_revision: ActionPolicyRevision,
        review_protocol_revision: impl Into<String>,
        recommendation: ClassifierRecommendation,
    ) -> Self {
        Self {
            assessment_id,
            action_digest,
            action_policy_revision,
            review_protocol_revision: review_protocol_revision.into(),
            recommendation,
        }
    }

    pub fn assessment_id(&self) -> &AssessmentId {
        &self.assessment_id
    }

    pub fn action_digest(&self) -> &ActionDigest {
        &self.action_digest
    }

    pub fn action_policy_revision(&self) -> &ActionPolicyRevision {
        &self.action_policy_revision
    }

    pub fn review_protocol_revision(&self) -> &str {
        &self.review_protocol_revision
    }

    pub fn recommendation(&self) -> &ClassifierRecommendation {
        &self.recommendation
    }
}
