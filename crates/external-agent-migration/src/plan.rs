use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use crate::import::{AgentImportDiagnostic, ExternalAgent, ImportItemKind, ImportScope};

/// Deterministic result of reading one external agent's known configuration into a plan.
#[derive(Clone, Default, PartialEq)]
pub struct MigrationPlan {
    items: Vec<MigrationPlanItem>,
    diagnostics: Vec<AgentImportDiagnostic>,
}

impl MigrationPlan {
    pub(crate) fn new(
        items: Vec<MigrationPlanItem>,
        diagnostics: Vec<AgentImportDiagnostic>,
    ) -> Self {
        Self { items, diagnostics }
    }

    pub fn items(&self) -> &[MigrationPlanItem] {
        &self.items
    }

    pub fn diagnostics(&self) -> &[AgentImportDiagnostic] {
        &self.diagnostics
    }
}

/// One importable migration entry discovered in a supported external agent layout.
///
/// Source paths are canonical host paths; every detail describes the external format, not Ash
/// configuration. Mapping fragments into Ash domains is the caller's adapter responsibility.
#[derive(Clone, PartialEq)]
pub struct MigrationPlanItem {
    agent: ExternalAgent,
    scope: ImportScope,
    kind: ImportItemKind,
    source_paths: Vec<PathBuf>,
    pub(crate) detail: MigrationItemDetail,
}

impl MigrationPlanItem {
    pub(crate) fn new(
        agent: ExternalAgent,
        scope: ImportScope,
        kind: ImportItemKind,
        source_paths: Vec<PathBuf>,
        detail: MigrationItemDetail,
    ) -> Self {
        Self {
            agent,
            scope,
            kind,
            source_paths,
            detail,
        }
    }

    pub fn agent(&self) -> ExternalAgent {
        self.agent
    }

    pub fn scope(&self) -> ImportScope {
        self.scope
    }

    pub fn kind(&self) -> ImportItemKind {
        self.kind
    }

    /// Canonical host paths backing this item.
    pub fn source_paths(&self) -> &[PathBuf] {
        &self.source_paths
    }

    pub fn detail(&self) -> &MigrationItemDetail {
        &self.detail
    }
}

/// Typed source-format fragment backing one [`MigrationPlanItem`].
#[derive(Clone, PartialEq)]
pub enum MigrationItemDetail {
    /// Parsed instruction with source loading semantics, without an Ash target schema.
    Instruction {
        document: crate::ExternalInstruction,
    },
    /// Parsed settings or configuration document in the external format.
    Settings { document: ExternalDocument },
    /// Skill directory names declared by the source layout.
    Skills { names: Vec<String> },
    /// Command file stems that migrate into skills.
    Commands { names: Vec<String> },
    /// Agent definitions parsed from external frontmatter documents.
    Agents {
        definitions: Vec<ExternalAgentDefinition>,
    },
    /// Rule file names declared by the source layout.
    Rules { names: Vec<String> },
    /// MCP server definitions discovered in external MCP configuration.
    McpServers { servers: Vec<ExternalMcpServer> },
    /// Hook groups discovered in external hook configuration, grouped by source event name.
    Hooks { events: Vec<ExternalHookEvent> },
    /// Enabled external plugins grouped by marketplace.
    Plugins {
        marketplaces: Vec<ExternalPluginMarketplace>,
    },
    /// Memory markdown files discovered under external project directories.
    Memory { files: Vec<ExternalMemoryFile> },
}

/// Parsed external settings or configuration document.
#[derive(Clone, PartialEq)]
pub enum ExternalDocument {
    Json(serde_json::Value),
    Toml(toml::Value),
}

/// Agent definition parsed from one external frontmatter document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAgentDefinition {
    pub name: String,
    pub description: String,
}

/// One external MCP server in source-format terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalMcpServer {
    pub name: String,
    /// `Err` marks a server whose source definition cannot be migrated deterministically.
    pub definition: Result<ExternalMcpDefinition, McpServerUnsupported>,
}

/// Normalized external MCP server transport and payload fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExternalMcpDefinition {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        /// Environment entries whose source value is a `${VAR}` placeholder.
        env_vars: Vec<String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
        /// Headers whose source value is a `${VAR}` placeholder, keyed by header name.
        env_headers: BTreeMap<String, String>,
        bearer_token_env_var: Option<String>,
    },
}

/// Reason why one external MCP server cannot be migrated deterministically.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpServerUnsupported {
    Disabled,
    MissingEndpoint,
    UnsupportedTransport,
    EnvPlaceholder,
}

/// Hook groups declared for one external source event name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalHookEvent {
    /// Source event name exactly as declared by the external format.
    pub event: String,
    /// Number of hook groups declared for the event.
    pub groups: usize,
    /// Groups where every hook is a well-formed command hook this crate understands.
    pub command_groups: usize,
}

/// Enabled external plugins declared for one marketplace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalPluginMarketplace {
    pub marketplace: String,
    pub plugins: Vec<String>,
    /// Marketplace source declared by the external registry, when known.
    pub source: Option<MarketplaceSource>,
}

/// Source location of one external plugin marketplace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketplaceSource {
    GitHub {
        repo: String,
        reference: Option<String>,
    },
    Git {
        url: String,
        reference: Option<String>,
    },
    Directory(PathBuf),
}

/// One memory markdown file discovered under an external project directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalMemoryFile {
    /// Encoded external project directory name.
    pub project_key: String,
    /// Canonical path of the discovered markdown file.
    pub source_path: PathBuf,
    /// Path of the file relative to the project memory root.
    pub relative_path: PathBuf,
}

impl fmt::Debug for MigrationPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MigrationPlan")
            .field("items", &self.items)
            .field("diagnostics", &self.diagnostics)
            .finish()
    }
}

impl fmt::Debug for MigrationPlanItem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MigrationPlanItem")
            .field("agent", &self.agent)
            .field("scope", &self.scope)
            .field("kind", &self.kind)
            .field("source_paths", &self.source_paths.len())
            .field("detail", &self.detail)
            .finish()
    }
}

impl fmt::Debug for MigrationItemDetail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Canonical host paths, settings documents, and environment values stay out of Debug.
        match self {
            Self::Instruction { .. } => formatter.write_str("Instruction(<redacted>)"),
            Self::Settings { .. } => formatter
                .debug_struct("Settings")
                .field("document", &"<redacted>")
                .finish(),
            Self::Skills { names } => formatter
                .debug_struct("Skills")
                .field("names", &names.len())
                .finish(),
            Self::Commands { names } => formatter
                .debug_struct("Commands")
                .field("names", &names.len())
                .finish(),
            Self::Agents { definitions } => formatter
                .debug_struct("Agents")
                .field("definitions", &definitions.len())
                .finish(),
            Self::Rules { names } => formatter
                .debug_struct("Rules")
                .field("names", &names.len())
                .finish(),
            Self::McpServers { servers } => formatter
                .debug_struct("McpServers")
                .field("servers", &servers.len())
                .finish(),
            Self::Hooks { events } => formatter
                .debug_struct("Hooks")
                .field("events", &events.len())
                .finish(),
            Self::Plugins { marketplaces } => formatter
                .debug_struct("Plugins")
                .field("marketplaces", &marketplaces.len())
                .finish(),
            Self::Memory { files } => formatter
                .debug_struct("Memory")
                .field("files", &files.len())
                .finish(),
        }
    }
}

impl fmt::Debug for ExternalDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}
