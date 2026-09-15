//! Versioned execution contract. Contains no Agent, Thread, or product state.

pub mod terminal;

use serde::Deserialize;
use serde::Serialize;

pub const VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 256 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentInfo {
    pub environment_id: String,
    pub incarnation: String,
    pub root: String,
    pub access: FileAccess,
    pub network: NetworkAccess,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NetworkAccess {
    Denied,
    Allowed,
}

/// Stable client-generated identity is scoped to the authenticated environment incarnation.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ProcessInput {
    Closed,
    Open,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessStart {
    pub operation_id: String,
    pub program: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub timeout_millis: u64,
    pub input: ProcessInput,
}

impl ProcessStart {
    pub fn validate(&self) -> Result<(), ExecError> {
        validate_id(&self.operation_id)?;
        if self.program.is_empty()
            || self.program.len() > 4096
            || self.program.contains('\0')
            || self.arguments.len() > 256
            || self
                .arguments
                .iter()
                .any(|arg| arg.len() > 65536 || arg.contains('\0'))
            || !(1..=43_200_000).contains(&self.timeout_millis)
        {
            return Err(ExecError::InvalidInput);
        }
        validate_path(&self.cwd)
    }
}

/// Paths are relative to the execution host's configured root, never to a client directory.
pub fn validate_path(path: &str) -> Result<(), ExecError> {
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path.contains(['\\', ':', '\0'])
        || path.split('/').any(|part| part == "..")
    {
        return Err(ExecError::InvalidInput);
    }
    Ok(())
}

pub fn validate_id(id: &str) -> Result<(), ExecError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(ExecError::InvalidInput);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ProcessState {
    Running,
    Exited { code: Option<i32> },
    Cancelled,
    TimedOut,
    Failed { message: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub text: String,
    pub next_cursor: u64,
    pub gap: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRead {
    pub operation_id: String,
    pub stdout_cursor: u64,
    pub stderr_cursor: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSnapshot {
    pub operation_id: String,
    pub state: ProcessState,
    pub stdout: Output,
    pub stderr: Output,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileContent {
    pub bytes: Vec<u8>,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", tag = "condition", content = "revision")]
pub enum WriteCondition {
    MissingOrEmpty,
    ExpectedRevision(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "method",
    content = "params",
    deny_unknown_fields
)]
pub enum Request {
    EnvironmentInfo,
    ProcessStart(ProcessStart),
    ProcessRead(ProcessRead),
    ProcessCancel {
        operation_id: String,
    },
    ProcessWrite {
        operation_id: String,
        bytes: Vec<u8>,
    },
    ProcessCloseInput {
        operation_id: String,
    },
    FileRead {
        path: String,
    },
    FileWrite {
        path: String,
        bytes: Vec<u8>,
        condition: WriteCondition,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    content = "value",
    deny_unknown_fields
)]
pub enum Response {
    Environment(EnvironmentInfo),
    Process(ProcessSnapshot),
    File(FileContent),
    Written,
    ProcessUpdated,
    Error(ExecError),
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExecError {
    Unauthorized,
    IncompatibleVersion,
    StaleEnvironment,
    InvalidInput,
    PermissionDenied,
    NotFound,
    Conflict,
    Busy,
    Io,
}

/// Credentials deliberately have no Debug implementation.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub version: u32,
    pub token: String,
    pub incarnation: Option<String>,
    pub request: Request,
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
