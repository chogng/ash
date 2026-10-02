use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestItem {
    pub id: String,
    pub package: String,
    pub target: String,
    pub target_kind: TargetKind,
    pub name: String,
    pub path: String,
    pub line: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetKind {
    Library,
    Binary,
    Integration,
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
}

pub(crate) struct Catalog {
    pub(crate) root: PathBuf,
    pub(crate) tests: Vec<TestItem>,
}
