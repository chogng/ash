//! Structured LLM-assisted review of fully resolved Agent actions.
//!
//! Classifier output is advisory. This crate never grants capabilities, starts actions, or
//! interprets a recommendation as authorization to bypass a sandbox.

mod classifier;
mod model_contract;
mod review_model;

pub use classifier::{AutoReviewError, LlmActionClassifier};
pub use review_model::{ReviewModel, ReviewModelError, ReviewModelRequest};

mod pool;
pub use pool::ReviewLimits;
pub use pool::ReviewTask;
pub use pool::ReviewerPool;
