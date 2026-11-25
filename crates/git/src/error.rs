use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub type GitResult<T> = Result<T, GitError>;

/// Known failures that prevent a linked checkout from being prepared.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitWorktreeSetupFailure {
    PathTooLong,
    LfsUnavailable,
    Locked,
}

/// Failure returned while configuring, invoking, or parsing a Git operation.
#[derive(Clone, Debug)]
pub enum GitError {
    ExecutableNotFound {
        source: Arc<io::Error>,
    },
    LaunchFailed {
        source: Arc<io::Error>,
    },
    UnsupportedVersion {
        installed: String,
    },
    IndexChanged,
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
    WorktreeSetupFailed {
        reason: GitWorktreeSetupFailure,
        source: Box<GitError>,
    },
    TagConflict {
        tags: Vec<String>,
    },
    InvalidOutput {
        command: String,
        detail: String,
    },
}

impl GitError {
    pub fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io {
            operation,
            source: Arc::new(source),
        }
    }

    pub fn runtime(operation: &'static str, detail: impl Into<String>) -> Self {
        Self::Runtime {
            operation,
            detail: detail.into(),
        }
    }

    pub(crate) fn classify_worktree_setup(self) -> Self {
        let Self::CommandFailed { stderr, .. } = &self else {
            return self;
        };
        for line in stderr.lines() {
            let diagnostic = line.to_ascii_lowercase();
            let reason = if diagnostic.ends_with("file name too long")
                || diagnostic.ends_with("filename too long")
            {
                GitWorktreeSetupFailure::PathTooLong
            } else if diagnostic.contains("git-lfs: not found")
                || (diagnostic.contains("git-lfs:")
                    || diagnostic.contains("'git-lfs'")
                    || diagnostic.contains("\"git-lfs\""))
                    && [
                        "command not found",
                        "not recognized",
                        "no such file",
                        "was not found",
                    ]
                    .iter()
                    .any(|cause| diagnostic.contains(cause))
            {
                GitWorktreeSetupFailure::LfsUnavailable
            } else if diagnostic.contains("unable to create '")
                && diagnostic.contains(".lock': file exists")
            {
                GitWorktreeSetupFailure::Locked
            } else {
                continue;
            };
            return Self::WorktreeSetupFailed {
                reason,
                source: Box::new(self),
            };
        }
        self
    }

    pub fn invalid_output(command: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::InvalidOutput {
            command: command.into(),
            detail: detail.into(),
        }
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExecutableNotFound { source } => write!(formatter, "locate Git failed: {source}"),
            Self::LaunchFailed { source } => write!(formatter, "start Git failed: {source}"),
            Self::UnsupportedVersion { installed } => write!(
                formatter,
                "Ash requires Git {} or newer; found {installed}. Upgrade Git and restart Ash.",
                crate::GitVersion::minimum_supported()
            ),
            Self::IndexChanged => formatter.write_str("Git index comparison changed"),
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
            Self::WorktreeSetupFailed { source, .. } => source.fmt(formatter),
            Self::InvalidOutput { command, detail } => {
                write!(formatter, "`{command}` returned invalid output: {detail}")
            }
            Self::TagConflict { tags } => {
                write!(formatter, "Conflicting local tags: {}", tags.join(", "))
            }
        }
    }
}

impl std::error::Error for GitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. }
            | Self::ExecutableNotFound { source }
            | Self::LaunchFailed { source } => Some(source.as_ref()),
            Self::WorktreeSetupFailed { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub(crate) fn invalid_command(reason: &'static str) -> GitError {
    GitError::InvalidConfiguration {
        field: "Git command",
        requirement: reason,
    }
}
