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
pub struct AgentToolSetCapabilityDto {
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
    pub tool_sets: Vec<AgentToolSetCapabilityDto>,
    pub local_process_sandbox_configured: bool,
    pub sandbox_backends: Vec<String>,
    pub sandbox_diagnostics: Vec<SandboxDiagnosticDto>,
    pub directory_grants_readable: bool,
}

/// Current read-only preparation checks. Every real command is still checked before launch.
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
