use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

/// Workspace definitions contain user intent only. Adapter bindings, session
/// addresses, evaluation results and editor objects never enter this document.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugWorkspaceState {
    pub breakpoints: Vec<DebugSourceBreakpoint>,
    pub function_breakpoints: Vec<DebugFunctionBreakpoint>,
    pub data_breakpoints: Vec<DebugDataBreakpoint>,
    pub watch_expressions: Vec<String>,
    pub exception_breakpoints: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugBreakpointDefinition {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hit_condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub log_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSourceBreakpoint {
    #[serde(flatten)]
    pub base: DebugBreakpointDefinition,
    pub resource: String,
    pub line_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub column_number: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugFunctionBreakpoint {
    #[serde(flatten)]
    pub base: DebugBreakpointDefinition,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugDataBreakpoint {
    #[serde(flatten)]
    pub base: DebugBreakpointDefinition,
    pub data_id: String,
    pub description: String,
    pub adapter_type: String,
    pub access_type: crate::DebugDataAccess,
    pub access_types: Vec<crate::DebugDataAccess>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugWorkspaceSnapshot {
    #[ts(type = "number")]
    pub revision: u32,
    pub state: DebugWorkspaceState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugWorkspaceStatus {
    Current,
    Applied,
    Conflict,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugWorkspaceResult {
    pub status: DebugWorkspaceStatus,
    pub snapshot: DebugWorkspaceSnapshot,
}

/// Edits are identity-based so a client that starts before the first snapshot
/// can submit its intent without replacing definitions it has not read yet.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum DebugWorkspaceEdit {
    ClearBreakpoints,
    SetEnabled {
        enabled: bool,
    },
    Source {
        point: DebugSourceBreakpoint,
    },
    Function {
        point: DebugFunctionBreakpoint,
    },
    Data {
        point: DebugDataBreakpoint,
    },
    Remove {
        ids: Vec<String>,
    },
    AddWatch {
        expression: String,
    },
    RemoveWatch {
        expression: String,
    },
    Exceptions {
        adapter_type: String,
        filters: Vec<String>,
    },
}
