use async_utils::CancellationToken;
use std::fmt;

/// Failure reported by the review-only model adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewModelError {
    Invocation(String),
    /// A transient service failure that may be retried within the same assessment deadline.
    Transient(String),
    ResponseTooLarge {
        bytes: usize,
    },
}

impl fmt::Display for ReviewModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invocation(message) | Self::Transient(message) => formatter.write_str(message),
            Self::ResponseTooLarge { bytes } => {
                write!(
                    formatter,
                    "review model response exceeded its limit: {bytes} bytes"
                )
            }
        }
    }
}

impl std::error::Error for ReviewModelError {}

/// Invokes a model in a review-only environment with no tools or mutable Agent context.
///
/// Implementations must observe `cancellation` before starting network I/O and at every supported
/// provider checkpoint. Cancellation never produces a recommendation. Implementations should
/// enforce the response budget while collecting provider output; the classifier checks it again
/// before parsing.
pub trait ReviewModel: Send + Sync {
    fn complete(
        &self,
        request: &ReviewModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<String, ReviewModelError>;
}

/// Exact prompt payload and response budget passed to the configured review model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewModelRequest {
    system_prompt: &'static str,
    input_json: String,
    response_schema_json: &'static str,
    maximum_response_bytes: usize,
}

impl ReviewModelRequest {
    pub(crate) fn new(
        system_prompt: &'static str,
        input_json: String,
        response_schema_json: &'static str,
        maximum_response_bytes: usize,
    ) -> Self {
        Self {
            system_prompt,
            input_json,
            response_schema_json,
            maximum_response_bytes,
        }
    }

    pub fn system_prompt(&self) -> &str {
        self.system_prompt
    }

    pub fn input_json(&self) -> &str {
        &self.input_json
    }

    pub fn response_schema_json(&self) -> &str {
        self.response_schema_json
    }

    pub fn maximum_response_bytes(&self) -> usize {
        self.maximum_response_bytes
    }
}
