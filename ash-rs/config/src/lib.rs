//! Durable user configuration authority and its resolved runtime snapshot.
//!
//! This crate owns ordinary, non-secret user configuration. It does not own credential values,
//! Plugin packages, MCP connections, or any live runtime state.

mod issues;
pub use issues::IssueConfig;
mod codebase;
mod command;
mod commit_messages;
mod dir_config;
mod dir_permissions;
mod document;
mod document_migration;
mod exec_policy;
mod git;
mod hooks;
mod language_servers;
mod mcp;
mod mutation;
mod plugins;
mod resolution;
mod skills;
mod store;
mod store_file;
mod store_monitor;
mod store_schema;
mod tool_search;

pub use ash_file_access::DirId;
pub use ash_protocol::{ModelRef, SkillId, SkillName, SkillSourceId, ToolMode};
pub use codebase::{CodebaseAutomaticContext, CodebaseConfig, CodebaseModelSelection};
pub use command::{
    ConfigCommandDisposition, ConfigCommandError, ConfigCommandRequest, ConfigCommandResult,
    PreferencesUpdate, UserConfigCommand,
};
pub use commit_messages::{CommitMessageConfig, CommitMessageEgressGrant};
pub use dir_config::{
    DirAgentConfig, DirConfigDocument, DirConfigIntent, DirConfigRevision, DirConfigScope,
    DirConfigStore, DirMcpConfig, DirMcpServerConfig, DirSkillsConfig,
};
pub use dir_permissions::DirPermissionsConfig;
pub use document::{
    AgentConfig, ApprovalReviewModelSelection, ConfigGeneration, ConfigRevision, GrepBackend,
    GrepConfig, NetworkConfig, ResolvedConfig, ResolvedConfigSnapshot, UserConfigDocument,
};
pub use exec_policy::{DirExecPolicyConfig, UserExecPolicyConfig, compose_exec_policy};
pub use git::{GitAutoFetchMode, GitConfig};
pub use hooks::{
    HookAction, HookConfig, HookEnablement, HookEvent, HookId, HookMatcher, HooksConfig,
};
pub use language_servers::{
    LanguageServerConfig, LanguageServerId, LanguageServerModeConfig, LanguageServersConfig,
};
pub use mcp::{
    McpConfig, McpCredentialBinding, McpServerConfig, McpServerEnablement, McpServerId,
    McpTransportConfig,
};
pub use plugins::{
    DirPluginRequest, DirPluginRequestScope, DirPluginRequests, PluginPackageId, PluginRequest,
    PluginRequestEnablement, PluginVersion, PluginsConfig,
};
pub use resolution::{
    ConfigDiagnostic, ConfigDiagnosticCode, ConfigProvenance, ConfigValueSource, DirConfigInput,
    ScopedConfigSnapshot, resolve_scoped_config,
};
pub use skills::{SkillEnablement, SkillSourceConfig, SkillSourceEnablement, SkillsConfig};
pub use store::{ConfigChange, ConfigError, ConfigStore};
pub use tool_search::ToolSearchConfig;
pub use tool_search::ToolSearchModeConfig;

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

/// Version emitted in the canonical on-disk TOML document.
pub const CONFIG_FILE_SCHEMA_VERSION: i64 = document_migration::CURRENT_FILE_SCHEMA_VERSION;
mod time_context;
pub use time_context::TimeContextConfig;
