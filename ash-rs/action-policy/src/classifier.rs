use crate::ActionDigest;
use crate::ActionPolicyRevision;
use crate::ActionReviewRequest;
use crate::CapabilitySet;
use ash_async_utils::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::fmt;

/// Produces advisory assessments consumed by the deterministic policy engine.
///
/// Implementations must not execute actions or grant capabilities. They must propagate
/// cancellation, bind successful assessments to the supplied request identities, and return an
/// error without a recommendation when their result cannot be trusted.
pub trait ActionClassifier: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error>;
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

/// Explains why advisory output is incompatible with the action it reviewed.
///
/// Classifier implementations may use this validation before returning an assessment, while the
/// policy engine always applies it again before interpreting advisory output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecommendationValidationError {
    EmptyApprovalCapabilities,
    ApprovalCapabilitiesMismatch,
    RevisedCapabilitiesExceeded,
}

impl fmt::Display for RecommendationValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyApprovalCapabilities => {
                formatter.write_str("reviewer approved no capabilities")
            }
            Self::ApprovalCapabilitiesMismatch => {
                formatter.write_str("reviewer approved capabilities outside the resolved action")
            }
            Self::RevisedCapabilitiesExceeded => {
                formatter.write_str("reviewer proposed a revised action with broader capabilities")
            }
        }
    }
}

impl Error for RecommendationValidationError {}

impl ClassifierRecommendation {
    /// Validates capability constraints against the exact resolved action.
    ///
    /// Approval must cover the complete non-empty capability set. A proposed revision may narrow
    /// the set, including to an empty set, but may never broaden it.
    pub fn validate_against(
        &self,
        required: &CapabilitySet,
    ) -> Result<(), RecommendationValidationError> {
        match self {
            Self::Approve { capabilities, .. } if capabilities.is_empty() => {
                Err(RecommendationValidationError::EmptyApprovalCapabilities)
            }
            Self::Approve { capabilities, .. } if capabilities != required => {
                Err(RecommendationValidationError::ApprovalCapabilitiesMismatch)
            }
            Self::ReviseAction {
                maximum_capabilities,
                ..
            } if !maximum_capabilities.is_subset(required) => {
                Err(RecommendationValidationError::RevisedCapabilitiesExceeded)
            }
            _ => Ok(()),
        }
    }
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
