use crate::ToolCallId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// One stable, secret-free hop in the source chain of a durable Tool Call binding.
///
/// Hosts append hops in distribution-to-execution order. Mutable process identities, credentials,
/// session handles, and filesystem paths must never be stored here.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolSourceProvenance {
    Product {
        component: String,
    },
    Plugin {
        plugin_id: String,
        version: String,
        package_digest: String,
        contribution_id: String,
    },
    Mcp {
        server_id: String,
        remote_name: String,
        #[ts(type = "number")]
        catalog_generation: u64,
        #[ts(type = "number")]
        connection_generation: u64,
    },
    Dynamic {
        name: String,
    },
    Extension {
        id: String,
    },
    System {
        id: String,
    },
}

/// Identifies how the model-visible Tool Call reached the ordinary tool scheduler.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolCallCaller {
    Direct,
    CodeMode {
        parent_tool_call_id: ToolCallId,
        cell_id: String,
        runtime_call_id: String,
    },
}

/// The user-facing operation declared by the tool owner when a call is bound.
///
/// This describes transcript presentation. Authorization and side-effect policy remain owned by
/// the action review path; a command may still change files.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolActivity {
    Read { target: String },
    Search { target: String },
    List { target: String },
    Edit { target: String },
    Run,
}

/// Durable binding between one Tool Call and the exact definition/source generation it selected.
///
/// Runtime keys are intentionally absent. Recovery must compare this value with an available
/// immutable source snapshot and fail closed when the exact binding can no longer be restored.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_incarnation: Option<String>,
    #[ts(type = "number")]
    pub registry_generation: u64,
    pub definition_digest: String,
    pub source_chain: Vec<ToolSourceProvenance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ToolActivity>,
    pub caller: ToolCallCaller,
}

impl ToolCallBinding {
    /// Presentation metadata can be absent in older calls without changing their execution source.
    pub fn matches_execution_source(&self, other: &Self) -> bool {
        self.registry_incarnation == other.registry_incarnation
            && self.registry_generation == other.registry_generation
            && self.definition_digest == other.definition_digest
            && self.source_chain == other.source_chain
            && self.caller == other.caller
    }
}
