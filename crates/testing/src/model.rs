use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestItem {
    pub id: String,
    pub package: String,
    pub target: String,
    pub target_kind: TargetKind,
    pub name: String,
    pub source: Option<TestSource>,
    pub debuggable: bool,
    pub(crate) directory: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestSource {
    pub path: String,
    pub line: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetKind {
    Library,
    Binary,
    Integration,
    Documentation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TestState {
    Running,
    Passed,
    Failed,
    Skipped,
    Errored,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestResult {
    pub test_id: String,
    pub state: TestState,
    pub duration_ms: u64,
    pub output: String,
    pub output_truncated: bool,
    pub failure_path: Option<String>,
    pub failure_line: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Discovery,
    Run,
    Debug,
}

/// Prepared launch consumed by the existing DAP owner; it never starts a second debugger host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugLaunch {
    pub test_id: String,
    pub program: String,
    pub arguments: Vec<String>,
    pub directory: String,
    pub adapter_program: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub operation_id: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    pub tests: Vec<TestItem>,
    pub results: Vec<TestResult>,
    pub error: Option<String>,
    pub sequence: u64,
    pub launch: Option<DebugLaunch>,
}

/// Ordered changes are delivered to the connection that started the operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Update {
    pub operation_id: String,
    pub sequence: u64,
    pub status: OperationStatus,
    pub tests: Option<Vec<TestItem>>,
    pub result: Option<TestResult>,
    pub error: Option<String>,
    pub launch: Option<DebugLaunch>,
}

pub(crate) struct Catalog {
    pub(crate) root: PathBuf,
    pub(crate) tests: Vec<TestItem>,
    pub(crate) documentation_names: std::collections::HashMap<String, Vec<String>>,
}
