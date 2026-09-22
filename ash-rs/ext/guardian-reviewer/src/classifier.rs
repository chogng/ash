use crate::protocol::{self, CURRENT_REVIEW_PROTOCOL};
use crate::review_model::{ReviewModel, ReviewModelError, ReviewModelRequest};
use action_policy::{
    ActionClassifier, ActionReviewRequest, AssessmentId, ClassifierAssessment,
    ClassifierRecommendation,
};
use async_utils::CancellationToken;
use std::fmt;

const MAX_MODEL_INPUT_BYTES: usize = 64 * 1024;
const MAX_MODEL_INPUT_TOKENS: usize = 16 * 1024;
const MAX_MODEL_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AutoReviewError {
    Model(String),
    Transient(String),
    Cancelled,
    InvalidRequest(String),
    RequestTooLarge { bytes: usize },
    InvalidResponse(String),
    ResponseTooLarge { bytes: usize },
}

impl fmt::Display for AutoReviewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(message) | Self::Transient(message) => {
                write!(formatter, "review model failed: {message}")
            }
            Self::Cancelled => formatter.write_str("automatic review was cancelled"),
            Self::InvalidRequest(message) => {
                write!(formatter, "automatic review request was invalid: {message}")
            }
            Self::RequestTooLarge { bytes } => {
                write!(
                    formatter,
                    "automatic review request exceeded its limit: {bytes} bytes"
                )
            }
            Self::InvalidResponse(message) => {
                write!(
                    formatter,
                    "review model returned an invalid response: {message}"
                )
            }
            Self::ResponseTooLarge { bytes } => {
                write!(
                    formatter,
                    "review model response exceeded its limit: {bytes} bytes"
                )
            }
        }
    }
}

impl std::error::Error for AutoReviewError {}

/// Strict JSON classifier backed by a separately configured review model.
pub struct LlmActionClassifier<M> {
    model: M,
}

impl<M: ReviewModel> LlmActionClassifier<M> {
    /// Creates a classifier using the crate's current versioned review protocol.
    pub fn new(model: M) -> Self {
        Self { model }
    }

    fn model_request(
        &self,
        request: &ActionReviewRequest,
    ) -> Result<ReviewModelRequest, AutoReviewError> {
        let fixed_bytes = CURRENT_REVIEW_PROTOCOL.system_prompt().len()
            + CURRENT_REVIEW_PROTOCOL.response_schema_json().len();
        let context = guardian_context::fit(
            request.context(),
            guardian_context::RequestBudget {
                max_bytes: MAX_MODEL_INPUT_BYTES,
                max_estimated_tokens: MAX_MODEL_INPUT_TOKENS,
            },
            |context| {
                protocol::input_with_context(request, context)
                    .map(|input| input.len() + fixed_bytes)
            },
        )
        .map_err(|error| match error {
            guardian_context::BudgetError::Serialization(error) => {
                AutoReviewError::InvalidRequest(error.to_string())
            }
            guardian_context::BudgetError::RequiredContextTooLarge { bytes } => {
                AutoReviewError::RequestTooLarge { bytes }
            }
        })?;
        let input_json = protocol::input_with_context(request, &context)
            .map_err(|error| AutoReviewError::InvalidRequest(error.to_string()))?;
        Ok(ReviewModelRequest::new(
            CURRENT_REVIEW_PROTOCOL.system_prompt(),
            input_json,
            CURRENT_REVIEW_PROTOCOL.response_schema_json(),
            MAX_MODEL_RESPONSE_BYTES,
        ))
    }

    fn parse_recommendation(
        request: &ActionReviewRequest,
        response: &str,
    ) -> Result<ClassifierRecommendation, AutoReviewError> {
        let recommendation = protocol::parse_recommendation(response)
            .map_err(|error| AutoReviewError::InvalidResponse(error.to_string()))?;
        recommendation
            .validate_against(request.action().required_capabilities())
            .map_err(|error| AutoReviewError::InvalidResponse(error.to_string()))?;
        Ok(recommendation)
    }
}

impl<M: ReviewModel> ActionClassifier for LlmActionClassifier<M> {
    type Error = AutoReviewError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClassifierAssessment, AutoReviewError> {
        if cancellation.is_cancelled() {
            return Err(AutoReviewError::Cancelled);
        }
        let model_request = self.model_request(request)?;
        let response = match self.model.complete(&model_request, cancellation) {
            Ok(response) => response,
            Err(_) if cancellation.is_cancelled() => return Err(AutoReviewError::Cancelled),
            Err(ReviewModelError::Transient(message)) => {
                return Err(AutoReviewError::Transient(message));
            }
            Err(ReviewModelError::Invocation(message)) => {
                return Err(AutoReviewError::Model(message));
            }
            Err(ReviewModelError::ResponseTooLarge { bytes }) => {
                return Err(AutoReviewError::ResponseTooLarge { bytes });
            }
        };
        if cancellation.is_cancelled() {
            return Err(AutoReviewError::Cancelled);
        }
        if response.len() > model_request.maximum_response_bytes() {
            return Err(AutoReviewError::ResponseTooLarge {
                bytes: response.len(),
            });
        }
        let recommendation = Self::parse_recommendation(request, &response)?;
        let response_json_bytes = protocol::response_json_bytes(&recommendation)
            .map_err(|error| AutoReviewError::InvalidResponse(error.to_string()))?;
        Ok(ClassifierAssessment::new(
            AssessmentId::from_response(
                request.action().digest(),
                request.action_policy_revision(),
                CURRENT_REVIEW_PROTOCOL.revision(),
                response_json_bytes,
            ),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            CURRENT_REVIEW_PROTOCOL.revision(),
            recommendation,
        ))
    }
}

#[cfg(test)]
#[path = "classifier_tests.rs"]
mod tests;
