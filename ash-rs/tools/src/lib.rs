//! Shared host-side tool definitions, validation, and source adapters.
//!
//! This crate intentionally does not schedule tools, own durable Thread state,
//! manage MCP sessions, or perform provider wire encoding. Those responsibilities
//! remain with Core, source runtimes, and provider adapters respectively.

mod binding;
mod code_mode;
mod definition;
mod discovery;
mod dynamic;
mod error;
mod execution;
mod identity;
mod image_detail;
mod mcp;
mod output;
mod protocol_adapter;
mod registry;
mod schema;

pub use ash_environment::EnvId;
pub use ash_protocol::{ImageDetail, ToolCallId, ToolName};
pub use ash_protocol::{
    ProcessExecutionOutput, ProcessExitStatus, SandboxDenialOutput, ToolReplaySafety,
};
pub use ash_utils_output_truncation::{DEFAULT_TOOL_OUTPUT_MAX_BYTES, ToolOutputTruncationPolicy};
pub use binding::ToolBinding;
pub use code_mode::{
    CodeModeNestedCall, CodeModeProjection, CodeModeProjectionError, CodeModeToolBinding,
    CodeModeToolDefinition, CodeModeToolName,
};
pub use definition::{
    FreeformFormat, ToolDefinition, ToolDefinitionDigest, ToolInvocationKind, ToolLoading,
    ToolOutputSchema, ToolSchemaMode,
};
pub use discovery::{
    CapabilityDiscoveryId, CapabilityDiscoveryRequest, CapabilityDiscoverySnapshot,
    DiscoverableCapability, DiscoverableConnectorInfo, DiscoverableContributionKinds,
    DiscoverablePluginInfo, DiscoveryAction, DiscoveryClientCapabilities, DiscoveryValueError,
};
pub use dynamic::from_dynamic_tool_spec;
pub use error::{
    DynamicToolAdapterError, McpToolAdapterError, ProtocolToolAdapterError, ToolDefinitionError,
    ToolRegistryError, ToolSchemaError, ToolSearchError,
};
pub use execution::{
    ToolConcurrency, ToolConflictClass, ToolExecutionContext, ToolExecutionFuture,
    ToolExecutionOutcome, ToolExecutor, ToolExposure, ToolInvocation, ToolPayload,
    ToolRuntimeAuthority, ToolStartFailure, ToolUncertainOutcome,
};
pub use identity::{
    ToolBindingId, ToolIdentityError, ToolOperationId, ToolRegistryGeneration, ToolRuntimeKey,
};
pub use image_detail::{
    ImageDetailCapabilities, ImageDetailDecision, ImageDetailDecisionReason, ImageDetailSelection,
    ImageSourceDetailPolicy, normalize_image_detail,
};
pub use mcp::{McpOutputSchemaProjection, McpToolProjection, from_mcp_tool_projection};
pub use output::{ToolContent, ToolOutput, ToolOutputStatus};
pub use protocol_adapter::{
    from_protocol_tool_definition, to_protocol_tool_definition, to_protocol_tool_result,
};
pub use registry::{
    LoadableToolSpec, RegisteredTool, TOOL_SEARCH_DEFAULT_LIMIT, TOOL_SEARCH_TOOL_NAME,
    ToolRegistryBuilder, ToolRegistryRegistration, ToolRegistrySnapshot, ToolSearchDocument,
    ToolSearchLimit, ToolSearchMatch, ToolSearchMetadata, ToolSearchQuery, ToolSearchQuerySyntax,
    ToolSearchResult, ToolSearchScore,
};
pub use schema::{ToolInputSchema, ToolSchema, ToolSchemaDigest};
