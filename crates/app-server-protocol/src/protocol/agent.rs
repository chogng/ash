use crate::JsonSchema;
use crate::TS;
use ash_protocol::AgentId;
use ash_protocol::AgentRoleSource;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_protocol::ToolSourceProvenance;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadParams {
    pub agent_id: AgentId,
}

/// One execution branch belonging to the requested Agent, including archived branches.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub origin: ThreadOrigin,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadResult {
    pub agent_id: AgentId,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    pub threads: Vec<AgentThread>,
}

/// One Agent definition that can be selected when creating a root Session.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleEntry {
    pub name: String,
    pub description: String,
    pub source: AgentRoleSource,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleListResult {
    pub agents: Vec<AgentRoleEntry>,
}

/// Product launch restrictions are visible in Settings without becoming launch authority.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentRoleLaunch {
    Any,
    Workflow,
    Delegation,
    Host,
}

/// A validated definition for inspection, independent of the root Session picker.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleDefinition {
    pub name: String,
    pub description: String,
    pub source: AgentRoleSource,
    pub launch: AgentRoleLaunch,
    pub callers: Vec<String>,
    pub delegates: Option<Vec<String>>,
    pub path: Option<String>,
    pub content_digest: String,
    pub model: Option<String>,
    pub tools: Option<Vec<String>>,
    pub disallowed_tools: Vec<String>,
    pub required_tools: Vec<String>,
    pub delegation_tools: Option<Vec<String>>,
    pub disallowed_delegation_tools: Vec<String>,
    pub required_delegation_tools: Vec<String>,
    pub skills: Option<Vec<String>>,
    pub required_skills: Vec<String>,
    pub instructions: Vec<String>,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleCatalogResult {
    pub agents: Vec<AgentRoleDefinition>,
    pub diagnostics: Vec<String>,
}

/// Describes the authority a tool may request; the decision is made for each call.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolAuthorityDto {
    DirectoryRead,
    DirectoryWrite,
    ProcessExecution,
    ProductService,
    ProviderDefined,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolSourceDto {
    Environment,
    Dynamic,
    Extension,
    Host,
    Local,
    Mcp,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolExposureDto {
    Direct,
    Deferred,
    ModelOnly,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCapabilityDto {
    /// Semantic capability; source and execution authority remain separate dimensions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<ash_protocol::ToolCategory>,
    pub name: String,
    pub description: String,
    pub source: ToolSourceDto,
    pub source_chain: Vec<ToolSourceProvenance>,
    pub exposure: ToolExposureDto,
    pub authority: ToolAuthorityDto,
}

/// One source-owned group from the same catalog snapshot as its member tools.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolSourceGroupDto {
    pub id: String,
    pub source: ToolSourceDto,
    pub source_id: String,
    pub tools: Vec<String>,
}

/// A snapshot of registered tools and configured local process isolation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitiesReadResult {
    pub tools: Vec<AgentToolCapabilityDto>,
    pub source_groups: Vec<AgentToolSourceGroupDto>,
    pub tool_sets: Vec<ash_protocol::ToolSetDefinition>,
    pub profiles: Vec<ash_protocol::ToolProductProfile>,
    pub local_process_sandbox_configured: bool,
    pub sandbox_backends: Vec<String>,
    pub sandbox_diagnostics: Vec<SandboxDiagnosticDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sandbox_policy: Option<SandboxPolicyDto>,
    pub directory_grants_readable: bool,
}

/// Resolved command policy after profile selection and mandatory host constraints.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicyDto {
    pub profile: String,
    pub file_system: ash_protocol::SandboxMode,
    pub network: SandboxNetworkModeDto,
    pub host_read: SandboxHostReadDto,
    pub managed_constraints: bool,
    pub path_rule_count: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SandboxHostReadDto {
    Host,
    GrantedRoots,
}

/// Preparation under the current filesystem policy. Every command is checked again before launch.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDiagnosticDto {
    pub backend: String,
    pub network: SandboxNetworkModeDto,
    pub readiness: SandboxReadinessDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SandboxNetworkModeDto {
    Denied,
    Allowed,
    Managed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SandboxReadinessDto {
    Ready,
    Unsupported { reason: String },
    Unavailable { reason: String },
}
