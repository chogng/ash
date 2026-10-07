//! Read-only discovery of importable configuration from supported external coding agents.
//!
//! This crate recognizes documented Codex, Claude, Copilot, and Cursor configuration locations and produces an
//! immutable [`AgentPathInspection`] for a caller to preview, and reads their bounded source
//! formats into a migration [`MigrationPlan`]. It does not mutate Ash configuration, import
//! credentials, grant permissions, or own Desktop UI.

mod agent_paths;
mod claude;
mod codex;
mod copilot;
mod cursor;
mod instruction;
pub use instruction::ExternalInstruction;
pub use instruction::ExternalInstructionKind;
pub use instruction::ExternalInstructionLoad;
pub use instruction::detect_instruction_plan;
mod detect;
mod error;
mod frontmatter;
mod hooks;
mod import;
mod inspect_path;
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
pub use plan::{
    ExternalAgentDefinition, ExternalDocument, ExternalHookEvent, ExternalMcpDefinition,
    ExternalMcpServer, ExternalMemoryFile, ExternalPluginMarketplace, MarketplaceSource,
    McpServerUnsupported, MigrationItemDetail, MigrationPlan, MigrationPlanItem,
};
pub use scope::repository_root_for_cwd;
