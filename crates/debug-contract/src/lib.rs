//! Runtime debug domain contracts shared by the manager and product protocol.
//! These values contain no Workbench objects, transport envelopes or IO owners.
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSourceAddress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub source_reference: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum DebugBreakpointLocation {
    Source {
        source: DebugSourceAddress,
        line: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        column: Option<u32>,
    },
    Function {
        name: String,
    },
    Data {
        data_id: String,
        access_type: DebugDataAccess,
        adapter_type: String,
        can_persist: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        session_id: Option<String>,
    },
    Instruction {
        instruction_reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        offset: Option<i64>,
        session_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugDataAccess {
    Read,
    Write,
    ReadWrite,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugBreakpointIntent {
    pub id: String,
    pub enabled: bool,
    pub location: DebugBreakpointLocation,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugBreakpointUnsupported {
    Conditional,
    HitConditional,
    LogPoint,
    Function,
    Data,
    Instruction,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugBreakpointBinding {
    pub intent: DebugBreakpointIntent,
    pub verified: bool,
    pub applicable: bool,
    pub pending: bool,
    pub removed: bool,
    pub created: bool,
    pub unsupported: Option<DebugBreakpointUnsupported>,
    pub message: Option<String>,
    #[ts(type = "unknown")]
    pub protocol: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugBreakpointsSnapshot {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub version: u64,
    #[ts(type = "number")]
    pub applied_version: u64,
    pub bindings: Vec<DebugBreakpointBinding>,
    pub error: Option<String>,
}

/// Selection is explicit per operation; a backend session has no globally
/// selected thread/frame. Each query is fenced to its captured inspection epoch.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum DebugInspection {
    Stack {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        thread_id: Option<i64>,
    },
    Frame {
        #[ts(type = "number")]
        frame_id: i64,
    },
    Variables {
        #[ts(type = "number")]
        variables_reference: u64,
    },
    Watch {
        expressions: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        frame_id: Option<i64>,
    },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugWatchValue {
    pub expression: String,
    #[ts(type = "unknown")]
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugScopeVariables {
    #[ts(type = "unknown")]
    pub scope: Value,
    #[ts(type = "unknown[]")]
    pub variables: Vec<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum DebugInspectionValue {
    Stack {
        #[ts(type = "unknown[]")]
        threads: Vec<Value>,
        #[ts(type = "unknown[]")]
        frames: Vec<Value>,
        #[ts(type = "number | null")]
        thread_id: Option<i64>,
    },
    Frame {
        scopes: Vec<DebugScopeVariables>,
    },
    Variables {
        #[ts(type = "unknown[]")]
        variables: Vec<Value>,
    },
    Watch {
        values: Vec<DebugWatchValue>,
    },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum DebugInspectionResult {
    Pending,
    Complete { value: DebugInspectionValue },
    Failed { message: String },
    Invalidated,
}

#[cfg(test)]
#[path = "contract_tests.rs"]
mod tests;
