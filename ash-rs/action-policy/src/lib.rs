//! Action permission contracts and final execution-decision authority.
//!
//! This crate consumes deterministic [`ash_execpolicy`] evaluation, exact grants, sandbox
//! compatibility, and output from an injected advisory classifier. It never executes actions;
//! callers must durably record approval interactions before honoring `AskUser`.

mod action;
mod classifier;
mod decision;
mod engine;
mod grant;
mod grants;

pub use action::ActionReviewRequest;
pub use action::ResolvedAction;
pub use action::SandboxCompatibility;
pub use classifier::ActionClassifier;
pub use classifier::RecommendationValidationError;
pub use decision::{
    ApprovalRequest, AutoReviewGrant, BlockReason, DeterministicPolicyGrant, ExecutionDecision,
    PermissionBypassGrant, PolicyError, ReviewFailurePolicy, SaferActionRequest,
};
pub use engine::ActionPolicyEngine;
pub use grant::{GrantId, UnsandboxedGrant};
pub use grants::UserAllowlist;

pub use action::derive_action_policy_revision;
pub use classifier::validate_recommendation;
