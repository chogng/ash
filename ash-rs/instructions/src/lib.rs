//! Bounded discovery and immutable snapshots for Ash Instruction artifacts.
//!
//! This crate owns the user and directory Instruction layouts, frontmatter
//! validation, loading policy, deterministic diagnostics, and bounded content reads. It does not
//! assemble model requests, watch files, interpret external Agent formats, or own directory access.

mod catalog;
mod model;

pub use catalog::InstructionCatalog;
pub use model::InstructionArtifact;
pub use model::InstructionCatalogSnapshot;
pub use model::InstructionDiagnostic;
pub use model::InstructionDiagnosticCode;
pub use model::InstructionLoadPolicy;

/// Valid, inactive starting content for a newly created Ash Instruction file.
pub const STARTER_TEMPLATE: &str = include_str!("../assets/starter.md");

/// Plain Markdown starting content for an always-on `AGENTS.md` or `ASH.md`.
pub const STARTER_ALWAYS_ON_TEMPLATE: &str = include_str!("../assets/always-on.md");
