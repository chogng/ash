//! Shared lifecycle contracts for agent runtime extensions.

mod context;
mod contributors;
mod fragment;
mod lifecycle;
mod registry;
pub use lifecycle::IdleContributor;
pub use lifecycle::ItemContributor;
pub use lifecycle::LifecycleObserver;
pub use lifecycle::ThreadContext;
pub use lifecycle::ThreadLifecycle;

pub use ash_context_fragments::ContextEvidence;
pub use ash_context_fragments::FragmentRetention as PromptFragmentRetention;
pub use ash_context_fragments::FragmentSource as PromptFragmentSource;
pub use context::ContextContributor;
pub use context::ContextSourceRequest;
pub use contributors::CapabilityToolContribution;
pub use contributors::CapabilityToolContributor;
pub use contributors::ExtensionToolAuthority;
pub use contributors::ReadOnlyToolContributor;
pub use contributors::SkillActivationContext;
pub use contributors::SkillActivationContributor;
pub use contributors::TurnInputContext;
pub use contributors::TurnInputContributor;
pub use fragment::PromptFragment;
pub use fragment::PromptFragmentLayer;
pub use registry::ExtensionError;
pub use registry::ExtensionRegistry;
pub use registry::ExtensionRegistryBuilder;

/// Registration used by the host's Skill runtime for model-facing Skill bodies.
pub const SKILL_TURN_INPUT_CONTRIBUTOR: &str = "skills";

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

pub use lifecycle::ContinuationContributor;
pub use lifecycle::ExtensionTurn;

mod items;
mod state;
pub use items::ExtensionItemStore;
pub use state::ExtensionScope;
pub use state::ExtensionState;

pub use lifecycle::ApprovalReviewContributor;
pub use lifecycle::McpLifecycle;
pub use lifecycle::McpLifecycleContributor;
pub use lifecycle::ToolLifecycle;
pub use lifecycle::ToolLifecycleContributor;

#[cfg(test)]
#[path = "state_tests.rs"]
mod state_tests;

/// Immutable reviewer selection frozen with an execution policy revision.
#[derive(Clone)]
pub enum ApprovalReviewer {
    Unavailable,
    Configured {
        identity: String,
        registry: std::sync::Arc<ExtensionRegistry>,
    },
}
