//! Advisory classifier port and policy-owned validation of its proposed capabilities.

use crate::ActionReviewRequest;
use ash_async_utils::CancellationToken;
use ash_protocol::CapabilitySet;
use ash_protocol::ClassifierAssessment;
use ash_protocol::ClassifierRecommendation;
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

/// Validates capability constraints against the exact resolved action.
///
/// Approval must cover the complete non-empty capability set. A proposed revision may narrow
/// the set, including to an empty set, but may never broaden it.
pub fn validate_recommendation(
    recommendation: &ClassifierRecommendation,
    required: &CapabilitySet,
) -> Result<(), RecommendationValidationError> {
    match recommendation {
        ClassifierRecommendation::Approve { capabilities, .. } if capabilities.is_empty() => {
            Err(RecommendationValidationError::EmptyApprovalCapabilities)
        }
        ClassifierRecommendation::Approve { capabilities, .. } if capabilities != required => {
            Err(RecommendationValidationError::ApprovalCapabilitiesMismatch)
        }
        ClassifierRecommendation::ReviseAction {
            maximum_capabilities,
            ..
        } if !maximum_capabilities.is_subset(required) => {
            Err(RecommendationValidationError::RevisedCapabilitiesExceeded)
        }
        _ => Ok(()),
    }
}
