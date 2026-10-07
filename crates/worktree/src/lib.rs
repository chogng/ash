//! Managed Git worktrees and durable isolated directory bindings.
//!
//! The crate discovers existing checkouts, provisions isolated directories from immutable
//! baselines, and cleans them only after the change ledger proves every ChangeSet settled.

mod binding;
mod manager;
mod metadata;
mod settings;

pub use manager::ManagedDirBinding;
pub use manager::ManagedDirCleanupEligibility;
pub use manager::ManagedDirKind;
pub use manager::ManagedDirOwner;
pub use manager::ManagedDirProvisionRequest;
pub use manager::ManagedDirSource;
pub use manager::ManagedDirTarget;
pub use manager::ManagedRepositoryBinding;
pub use manager::Worktree;
pub use manager::WorktreeAvailability;
pub use manager::WorktreeKind;
pub use manager::WorktreeManager;
pub use manager::WorktreeOwner;
pub use manager::WorktreeSelector;
pub use settings::DEFAULT_WORKTREE_KEEP_COUNT;
pub use settings::WorktreeSettings;

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;
