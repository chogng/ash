use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Discovers conventional Rust #[test] functions without building the workspace.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestingDiscoverParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
}

/// Selects exact identities from a completed, connection-owned discovery.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestingRunParams {
    pub operation_id: String,
    pub catalog_id: String,
    pub test_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestingOperationParams {
    pub operation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TestingTargetKind {
    Library,
    Binary,
    Integration,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestingItem {
    pub id: String,
    pub package: String,
    pub target: String,
    pub target_kind: TestingTargetKind,
    pub name: String,
    /// Slash-separated path relative to the authorized workspace directory.
    pub path: String,
    pub line: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TestingState {
    Running,
    Passed,
    Failed,
    Skipped,
    Errored,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestingResult {
    pub test_id: String,
    pub state: TestingState,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub output: String,
    pub output_truncated: bool,
    pub failure_path: Option<String>,
    pub failure_line: Option<usize>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TestingOperationKind {
    Discovery,
    Run,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TestingOperationStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// Read restores the state of an already-started operation; it never replays execution.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestingSnapshot {
    pub operation_id: String,
    pub kind: TestingOperationKind,
    pub status: TestingOperationStatus,
    pub tests: Vec<TestingItem>,
    pub results: Vec<TestingResult>,
    pub error: Option<String>,
    #[ts(type = "number")]
    pub sequence: u64,
}

/// Sequence-ordered updates go only to the issuing connection. Cancel waits for the final
/// update and process termination; release additionally discards the operation's backend state.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestingUpdate {
    pub operation_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    pub status: TestingOperationStatus,
    pub tests: Option<Vec<TestingItem>>,
    pub result: Option<TestingResult>,
    pub error: Option<String>,
}
