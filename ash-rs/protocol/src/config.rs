//! Shared preference values and partial-update semantics used by domain configuration.
//! Configuration storage, precedence, and application belong to their consuming domains.

mod patch;
mod preferences;

pub use patch::Patch;
pub use preferences::ApprovalMode;
pub use preferences::Personality;
pub use preferences::SandboxMode;
pub use preferences::Theme;
pub use preferences::WebSearchMode;
