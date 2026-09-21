use crate::JsonSchema;
use crate::TS;
use ash_protocol::CommandId;
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;
use ash_protocol::ToolMode;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

/// Profile-owned time information supplied to model requests.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeContextConfigDto {
    pub mode: ash_protocol::TimeContextMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub time_zone: Option<String>,
}

/// Selects the implementation behind the shared grep capability.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GrepBackendDto {
    Ripgrep,
    #[default]
    Tgrep,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ModelRef")]
pub struct ModelRefDto {
    #[schemars(length(min = 1))]
    pub provider: String,
    #[schemars(length(min = 1))]
    pub model: String,
}

/// Model pair used by Ash's local semantic codebase orchestration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseModelsDto {
    pub embedding_model: ModelRefDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub rerank_model: Option<ModelRefDto>,
}

/// Whether verified code evidence is automatically attached to an Agent Turn.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CodebaseAutomaticContextDto {
    #[default]
    Off,
    FirstInvocation,
}

/// Current authorization state for the active directory and configured semantic model pair.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseConfigDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub models: Option<CodebaseModelsDto>,
    pub automatic_context: CodebaseAutomaticContextDto,
}

/// User-selected retrieval mode for deferred Agent tools.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolSearchModeDto {
    #[default]
    Lexical,
    HybridEmbedding,
}

/// Runtime readiness of the optional Tool Search embedding path.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ToolSearchEmbeddingStatusDto {
    Disabled,
    Ready {
        model: ModelRefDto,
    },
    Unavailable {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        model: Option<ModelRefDto>,
        reason: String,
    },
}

/// Durable Tool Search preference plus the active App Server runtime status.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolSearchConfigDto {
    pub mode: ToolSearchModeDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub embedding_model: Option<ModelRefDto>,
    pub embedding_status: ToolSearchEmbeddingStatusDto,
}

/// User-facing selection for the model that reviews approval requests.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
#[ts(rename = "ApprovalReviewModelSelection")]
pub enum ApprovalReviewModelSelectionDto {
    Automatic,
    Explicit { model: ModelRefDto },
}

/// Non-secret declarative provider settings exposed through the App Server contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigDto {
    #[schemars(length(min = 1))]
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub custom: Option<CustomProviderConfigDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_context: BTreeMap<String, ModelContextConfigDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomProviderConfigDto {
    #[serde(default = "default_custom_context_window")]
    pub context_window: u32,
    #[serde(default)]
    pub order: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub name: String,
    pub protocol: CustomProviderProtocolDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CustomProviderProtocolDto {
    Responses,
    ChatCompletions,
    AnthropicMessages,
}

/// Model-specific context limits used by Core's deterministic budget planner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextConfigDto {
    pub context_window: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub auto_compact_token_limit: Option<u32>,
}

/// Non-secret credential binding for a standalone MCP server declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum McpCredentialBindingDto {
    Unauthenticated,
    Reference { credential_ref: String },
}

/// Desired enablement for a configured MCP server.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum McpServerEnablementDto {
    Disabled,
    Enabled,
}

/// Non-secret transport declaration for a standalone MCP server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum McpTransportDto {
    Stdio { command: String, args: Vec<String> },
    StreamableHttp { url: String },
}

/// Desired, runtime-free standalone MCP server configuration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfigDto {
    #[schemars(length(min = 1))]
    pub id: String,
    #[schemars(length(min = 1))]
    pub display_name: String,
    pub transport: McpTransportDto,
    pub credential: McpCredentialBindingDto,
    pub enablement: McpServerEnablementDto,
}

/// Desired enablement for one configured user Skill source.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillSourceEnablementDto {
    Disabled,
    Enabled,
}

/// Runtime-free declaration for one user-owned Skill source.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceConfigDto {
    #[schemars(length(min = 1))]
    pub id: String,
    #[schemars(length(min = 1))]
    pub root_reference: String,
    pub enablement: SkillSourceEnablementDto,
}

/// Desired participation of one exact Plugin request in future activation resolution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginRequestEnablementDto {
    Disabled,
    Enabled,
}

/// Declarative request for one exact Plugin package.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestDto {
    #[schemars(length(min = 1))]
    pub plugin_id: String,
    #[schemars(length(min = 1))]
    pub version: String,
    pub enablement: PluginRequestEnablementDto,
}

/// Safe-point event that may request a Hook execution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HookEventDto {
    BeforeTool,
    AfterTool,
    TurnCompleted,
}

/// Desired enablement of one Hook declaration.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HookEnablementDto {
    Disabled,
    Enabled,
}

/// Optional exact tool-name matcher for tool-related Hook events.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HookMatcherDto {
    pub tool_names: Vec<String>,
}

/// Runtime-free Hook action. Execution still requires policy and sandbox approval.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum HookActionDto {
    Process { program: String, args: Vec<String> },
}

/// Declarative Hook configuration exposed through the App Server contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HookConfigDto {
    #[schemars(length(min = 1))]
    pub id: String,
    pub event: HookEventDto,
    pub matcher: HookMatcherDto,
    pub action: HookActionDto,
    pub enablement: HookEnablementDto,
}

/// Durable user intent for one language server.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageServerModeDto {
    Disabled,
    Enabled,
}

/// Runtime-free language-server preference exposed through the App Server contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfigDto {
    pub mode: LanguageServerModeDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub executable: Option<String>,
}

/// Coarse action category available to deterministic execution-policy selectors.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExecPolicyActionKindDto {
    LocalProcess,
    FileSystemMutation,
    NetworkRequest,
    BrowserInteraction,
    ExternalServiceMutation,
    CredentialUse,
    SystemOperation,
}

/// One exact argv position in a command-prefix selector.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum ExecPolicyTokenDto {
    Literal(String),
    OneOf(Vec<String>),
}

/// Host matching semantics for one structured network target.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum ExecPolicyHostMatcherDto {
    Exact(String),
    DomainSuffix(String),
}

/// Scope matching semantics for one structured capability.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum ExecPolicyScopeMatcherDto {
    Exact(String),
    Prefix(String),
}

/// Deterministic selector over host-materialized action fields.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ExecPolicySelectorDto {
    Any,
    ActionDigest {
        digest: String,
    },
    ActionKind {
        action_kind: ExecPolicyActionKindDto,
    },
    Source {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        source_id: Option<String>,
    },
    CommandPrefix {
        pattern: Vec<ExecPolicyTokenDto>,
    },
    Network {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        protocol: Option<String>,
        host: ExecPolicyHostMatcherDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        port: Option<u16>,
    },
    Capability {
        capability_kind: String,
        scope: ExecPolicyScopeMatcherDto,
    },
    All {
        selectors: Vec<ExecPolicySelectorDto>,
    },
}

/// Effect produced when one execution-policy rule matches.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", content = "reason")]
pub enum ExecPolicyEffectDto {
    Continue,
    AllowUnsandboxed,
    RequireApproval,
    RequireSandbox,
    Deny(String),
}

/// One durable user-owned deterministic execution-policy rule.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecPolicyRuleDto {
    #[schemars(length(min = 1))]
    pub id: String,
    pub selector: ExecPolicySelectorDto,
    pub effect: ExecPolicyEffectDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub justification: Option<String>,
}

/// One frontend-owned root table whose keys are opaque to App Server.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(transparent)]
pub struct FrontendConfigDto(
    #[ts(type = "Record<string, unknown>")] pub BTreeMap<String, serde_json::Value>,
);

/// Current user configuration snapshot returned by `config/read`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadResult {
    pub time_context: TimeContextConfigDto,
    pub features: Vec<features::FeatureState>,
    pub issues: crate::protocol::issues::IssueConfigDto,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub generation: u64,
    pub model: Option<ModelRefDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub approval_review_model: ApprovalReviewModelSelectionDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub commit_message_model: Option<ModelRefDto>,
    pub commit_message_active_dir_authorized: bool,
    pub tool_mode: ToolMode,
    pub grep_backend: GrepBackendDto,
    pub gui: FrontendConfigDto,
    pub providers: BTreeMap<String, ProviderConfigDto>,
    pub mcp_servers: BTreeMap<String, McpServerConfigDto>,
    pub skill_sources: BTreeMap<String, SkillSourceConfigDto>,
    pub plugin_requests: BTreeMap<String, PluginRequestDto>,
    pub hooks: BTreeMap<String, HookConfigDto>,
    pub language_servers: BTreeMap<String, LanguageServerConfigDto>,
    pub tool_search: ToolSearchConfigDto,
    pub codebase: CodebaseConfigDto,
    pub exec_policy_rules: Vec<ExecPolicyRuleDto>,
    pub tui: FrontendConfigDto,
}

/// Creates or replaces one durable User execution-policy rule.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecPolicyRuleUpsertParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub rule: ExecPolicyRuleDto,
}

/// Removes one durable User execution-policy rule.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecPolicyRuleRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub rule_id: String,
}

/// Selects lexical Tool Search or enables one exact embedding model after a readiness probe.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolSearchConfigureParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub mode: ToolSearchModeDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub embedding_model: Option<ModelRefDto>,
}

/// Replaces the device-local semantic model selection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseConfigureParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub models: Option<CodebaseModelsDto>,
    #[serde(default)]
    pub automatic_context: CodebaseAutomaticContextDto,
}

/// Authorizes the active directory to send bounded context and diff to the exact summary model.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageAuthorizeParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
}

/// Revokes automatic commit-message source egress for the active directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageRevokeParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
}

/// Notification payload emitted after a durable Config authority commit.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChanged {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub generation: u64,
}

/// Compact result of a retry-safe configuration mutation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCommandResult {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub generation: u64,
    pub disposition: ConfigCommandDispositionDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConfigCommandDispositionDto {
    Updated,
    Replayed,
}

/// Patch for user preferences at one expected Config revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigUpdateParams {
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<TimeContextConfigDto>")]
    #[ts(as = "Option<TimeContextConfigDto>", optional = nullable)]
    pub time_context: Patch<TimeContextConfigDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<features::FeatureOverrides>")]
    #[ts(as = "Option<features::FeatureOverrides>", optional = nullable)]
    pub features: Patch<features::FeatureOverrides>,
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<ModelRefDto>")]
    #[ts(as = "Option<ModelRefDto>", optional = nullable)]
    pub model: Patch<ModelRefDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<ReasoningEffort>")]
    #[ts(as = "Option<ReasoningEffort>", optional = nullable)]
    pub model_reasoning_effort: Patch<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<ApprovalReviewModelSelectionDto>")]
    #[ts(as = "Option<ApprovalReviewModelSelectionDto>", optional = nullable)]
    pub approval_review_model: Patch<ApprovalReviewModelSelectionDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<ModelRefDto>")]
    #[ts(as = "Option<ModelRefDto>", optional = nullable)]
    pub commit_message_model: Patch<ModelRefDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<ToolMode>")]
    #[ts(as = "Option<ToolMode>", optional = nullable)]
    pub tool_mode: Patch<ToolMode>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<GrepBackendDto>")]
    #[ts(as = "Option<GrepBackendDto>", optional = nullable)]
    pub grep_backend: Patch<GrepBackendDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<FrontendConfigDto>")]
    #[ts(as = "Option<FrontendConfigDto>", optional = nullable)]
    pub gui: Patch<FrontendConfigDto>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    #[schemars(with = "Option<FrontendConfigDto>")]
    #[ts(as = "Option<FrontendConfigDto>", optional = nullable)]
    pub tui: Patch<FrontendConfigDto>,
}

/// Creates or replaces one user-owned language-server preference.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfigureParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub server_id: String,
    pub config: LanguageServerConfigDto,
}

/// Removes an explicit language-server preference and restores the product default.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub server_id: String,
}

/// Creates or replaces one provider entry in the user configuration authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigureParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub config: ProviderConfigDto,
}

/// Removes one provider entry from the user configuration authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub provider: String,
}

/// Creates or replaces one standalone MCP server declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerUpsertParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub server: McpServerConfigDto,
}

/// Removes one standalone MCP server declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub server_id: String,
}

/// Changes desired enablement for one configured standalone MCP server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSetEnablementParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub server_id: String,
    pub enablement: McpServerEnablementDto,
}

/// Adds a user-owned, runtime-free Skill source declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceAddParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub source: SkillSourceConfigDto,
}

/// Removes one user-owned Skill source declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub source_id: String,
}

/// Changes desired enablement for one configured user Skill source.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceSetEnablementParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub source_id: String,
    pub enablement: SkillSourceEnablementDto,
}

/// Creates or replaces one exact user Plugin request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestUpsertParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub request: PluginRequestDto,
}

/// Removes one user Plugin request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub plugin_id: String,
}

/// Changes desired enablement for one configured Plugin request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestSetEnablementParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub plugin_id: String,
    pub enablement: PluginRequestEnablementDto,
}

/// Creates or replaces one declarative user Hook.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HookUpsertParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub hook: HookConfigDto,
}

/// Removes one declarative user Hook.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HookRemoveParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub hook_id: String,
}

/// Changes desired enablement for one configured user Hook.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HookSetEnablementParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub hook_id: String,
    pub enablement: HookEnablementDto,
}

fn default_custom_context_window() -> u32 {
    272_000
}
