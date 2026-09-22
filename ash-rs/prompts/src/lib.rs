//! Shared prompt infrastructure and stable prompts used by more than one product path.
//!
//! Model-specific and feature-specific prompts stay with their owning crate. This crate owns the
//! common asset contract, shared Agent rules, permission descriptions, and continuation templates.

mod agent;
mod artifact;
mod compact;
mod permissions;
mod review;

pub use agent::AGENT_INSTRUCTIONS;
pub use agent::TURN_INTERRUPTED_PROMPT;
pub use artifact::PromptArtifact;
pub use artifact::RenderedPrompt;
pub use compact::COMPACTION_PROMPT;
pub use compact::checkpoint_prompt;
pub use compact::checkpoint_prompt_overhead;
pub use compact::checkpoint_summary_bytes;
pub use permissions::permissions_instructions;
pub use review::ReviewOutcome;
pub use review::ReviewPromptError;
pub use review::review_exit_prompt;
pub use review::review_target_prompt;

#[cfg(test)]
#[path = "prompt_tests.rs"]
mod tests;
