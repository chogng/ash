//! Read-only discovery of importable configuration from supported external coding agents.
//!
//! This crate recognizes documented Codex and Claude configuration locations and produces an
//! immutable [`AgentPathInspection`] for a caller to preview, and reads their bounded source
//! formats into a migration [`MigrationPlan`]. It does not mutate Ash configuration, import
//! credentials, grant permissions, or own Desktop UI.

mod agent_paths;
mod detect;
mod error;
mod frontmatter;
mod hooks;
mod import;
mod inspect_path;
mod instructions;
mod mcp;
mod memory;
mod plan;
mod plugins;
mod scope;
mod settings;
mod source;

#[cfg(test)]
#[path = "detect_tests.rs"]
mod detect_tests;

pub use detect::detect_migration_plan;
pub use error::AgentImportError;
pub use import::{
    AgentImportCandidate, AgentImportDiagnostic, AgentImportDiagnosticCode, AgentImportLocation,
    AgentPathInspection, ExternalAgent, ImportItemKind, ImportReviewCategory, ImportScope,
};
pub use inspect_path::inspect_agent_paths;
pub use instructions::ClaudeInstructionRead;
pub use instructions::ExternalInstruction;
pub use instructions::read_claude_instructions;
pub use plan::{
    ExternalAgentDefinition, ExternalDocument, ExternalHookEvent, ExternalMcpDefinition,
    ExternalMcpServer, ExternalMemoryFile, ExternalPluginMarketplace, MarketplaceSource,
    McpServerUnsupported, MigrationItemDetail, MigrationPlan, MigrationPlanItem,
};
pub use scope::repository_root_for_cwd;
