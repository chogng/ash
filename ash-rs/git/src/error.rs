use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub type GitResult<T> = Result<T, GitError>;

/// Failure returned while configuring, invoking, or parsing a Git operation.
#[derive(Clone, Debug)]
pub enum GitError {
    InvalidConfiguration {
        field: &'static str,
        requirement: &'static str,
    },
    InvalidStartPath {
        path: PathBuf,
    },
    NotAWorkingTree {
        path: PathBuf,
    },
    Io {
        operation: &'static str,
        source: Arc<io::Error>,
    },
    Runtime {
        operation: &'static str,
        detail: String,
    },
    TimedOut {
        command: String,
        timeout: Duration,
    },
    OutputLimitExceeded {
        command: String,
        stream: &'static str,
        limit_bytes: usize,
    },
    CommandFailed {
        command: String,
        exit_code: Option<i32>,
        stderr: String,
    },
    InvalidOutput {
        command: String,
        detail: String,
    },
}

impl GitError {
    pub(crate) fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io {
            operation,
            source: Arc::new(source),
        }
    }

    pub(crate) fn runtime(operation: &'static str, detail: impl Into<String>) -> Self {
        Self::Runtime {
            operation,
            detail: detail.into(),
        }
    }

    pub(crate) fn invalid_output(command: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::InvalidOutput {
            command: command.into(),
            detail: detail.into(),
        }
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration { field, requirement } => {
                write!(formatter, "Git configuration field {field} {requirement}")
            }
            Self::InvalidStartPath { path } => {
                write!(
                    formatter,
                    "Git start path does not exist: {}",
                    path.display()
                )
            }
            Self::NotAWorkingTree { path } => {
                write!(
                    formatter,
                    "path is not inside a Git working tree: {}",
                    path.display()
                )
            }
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Runtime { operation, detail } => {
                write!(formatter, "{operation} failed: {detail}")
            }
            Self::TimedOut { command, timeout } => {
                write!(formatter, "`{command}` timed out after {timeout:?}")
            }
            Self::OutputLimitExceeded {
                command,
                stream,
                limit_bytes,
            } => write!(
                formatter,
                "`{command}` exceeded the {stream} limit of {limit_bytes} bytes"
            ),
            Self::CommandFailed {
                command,
                exit_code,
                stderr,
            } => write!(
                formatter,
                "`{command}` failed with exit code {exit_code:?}: {stderr}"
            ),
            Self::InvalidOutput { command, detail } => {
                write!(formatter, "`{command}` returned invalid output: {detail}")
            }
        }
    }
}

impl std::error::Error for GitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source.as_ref()),
            _ => None,
        }
    }
}
