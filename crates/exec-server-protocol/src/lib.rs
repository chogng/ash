//! Versioned execution contract. Contains no Agent, Thread, or product state.

pub mod terminal;

use serde::Deserialize;
use serde::Serialize;

pub const VERSION: u32 = 6;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FILE_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_READ_WAIT_MILLIS: u64 = 1000;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentInfo {
    pub environment_id: String,
    pub incarnation: String,
    pub root: String,
    pub access: FileAccess,
    pub network: NetworkAccess,
    pub constraints: ExecutionConstraints,
    pub permission_source: String,
    pub permission_policy_revision: String,
    pub allowed_approval_modes: Vec<ash_protocol::ApprovalMode>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NetworkAccess {
    #[default]
    Denied,
    /// Every observed connection is authorized through an exact execution-host request.
    Managed,
    Allowed,
}

/// Environment-relative ceilings for one admitted operation. This is not an authorization grant.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionConstraints {
    pub file_access: FileAccess,
    pub command_access: FileAccess,
    pub network: NetworkAccess,
    pub host_read: ash_file_access::HostReadAccess,
    pub paths: Vec<ash_file_access::PathAccessRule>,
}

impl ExecutionConstraints {
    pub fn validate(&self) -> Result<(), ExecError> {
        if self.paths.len() > 2048 {
            return Err(ExecError::InvalidInput);
        }
        for rule in &self.paths {
            rule.validate().map_err(|_| ExecError::InvalidInput)?;
        }
        Ok(())
    }

    pub fn intersect(&self, other: &Self) -> Self {
        let narrow = |left, right| {
            if left == FileAccess::ReadOnly || right == FileAccess::ReadOnly {
                FileAccess::ReadOnly
            } else {
                FileAccess::ReadWrite
            }
        };
        let mut paths = self.paths.clone();
        for path in &other.paths {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        Self {
            file_access: narrow(self.file_access, other.file_access),
            command_access: narrow(self.command_access, other.command_access),
            network: if self.network == NetworkAccess::Denied
                || other.network == NetworkAccess::Denied
            {
                NetworkAccess::Denied
            } else if self.network == NetworkAccess::Managed
                || other.network == NetworkAccess::Managed
            {
                NetworkAccess::Managed
            } else {
                NetworkAccess::Allowed
            },
            host_read: if self.host_read == ash_file_access::HostReadAccess::GrantedRoots
                || other.host_read == ash_file_access::HostReadAccess::GrantedRoots
            {
                ash_file_access::HostReadAccess::GrantedRoots
            } else {
                ash_file_access::HostReadAccess::Host
            },
            paths,
        }
    }

    pub fn path_policy(&self) -> Result<ash_file_access::PathAccessPolicy, ExecError> {
        ash_file_access::PathAccessPolicy::new(
            match self.file_access {
                FileAccess::ReadOnly => ash_file_access::PathAccess::ReadOnly,
                FileAccess::ReadWrite => ash_file_access::PathAccess::ReadWrite,
            },
            self.paths.clone(),
        )
        .map(|policy| policy.with_host_read(self.host_read))
        .map_err(|_| ExecError::InvalidInput)
    }
}

/// Stable client-generated identity is scoped to the authenticated environment incarnation.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ProcessInput {
    Closed,
    Open,
    Terminal { rows: u16, cols: u16 },
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
        if let ProcessInput::Terminal { rows, cols } = self.input {
            if rows == 0 || cols == 0 {
                return Err(ExecError::InvalidInput);
            }
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
    /// Wait for new output or a terminal state; zero returns the current snapshot immediately.
    pub wait_millis: u64,
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

/// One revision-pinned range. Clients must discard the whole read if a later range conflicts.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChunk {
    pub bytes: Vec<u8>,
    pub revision: String,
    pub offset: u64,
    pub total_bytes: u64,
}

/// An exact proxy-observed target, scoped to one immutable process operation and request ID.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessNetworkRequest {
    pub request_id: String,
    pub protocol: network_proxy::NetworkProtocol,
    pub host: String,
    pub port: u16,
    pub method: Option<String>,
}

/// Uploads never change a workspace file until an explicit commit succeeds.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state", deny_unknown_fields)]
pub enum FileWriteState {
    Uploading { next_offset: u64 },
    Committed { revision: String },
    Aborted,
    Rejected { error: ExecError },
    OutcomeUnknown,
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
    /// Caller-supplied ceilings can only narrow the execution host's immutable permissions.
    Constrained {
        constraints: ExecutionConstraints,
        request: Box<Request>,
    },
    EnvironmentInfo,
    ProcessStart(ProcessStart),
    ProcessRead(ProcessRead),
    ProcessNetworkRequests {
        operation_id: String,
    },
    ResolveProcessNetworkRequest {
        operation_id: String,
        request_id: String,
        allow: bool,
    },
    ProcessCancel {
        operation_id: String,
    },
    ProcessWrite {
        operation_id: String,
        bytes: Vec<u8>,
    },
    ProcessResize {
        operation_id: String,
        rows: u16,
        cols: u16,
    },
    ProcessInterrupt {
        operation_id: String,
    },
    ProcessCloseInput {
        operation_id: String,
    },
    FileRead {
        path: String,
        offset: u64,
        expected_revision: Option<String>,
    },
    FileReadRelease {
        path: String,
        revision: String,
    },
    FileWriteBegin {
        operation_id: String,
        path: String,
        total_bytes: u64,
        content_revision: String,
        condition: WriteCondition,
    },
    FileWriteChunk {
        operation_id: String,
        offset: u64,
        bytes: Vec<u8>,
    },
    FileWriteCommit {
        operation_id: String,
    },
    FileWriteAbort {
        operation_id: String,
    },
    FileWriteStatus {
        operation_id: String,
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
    File(FileChunk),
    FileReadReleased,
    FileWrite(FileWriteState),
    ProcessUpdated,
    ProcessNetworkRequests(Vec<ProcessNetworkRequest>),
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
