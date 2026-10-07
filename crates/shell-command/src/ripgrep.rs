use crate::ShellCommandRequest;
use std::fmt;
use std::path::{Path, PathBuf};

/// Built-in restrictions that keep model-authored ripgrep arguments read-only and self-contained.
///
/// This policy rejects ripgrep features that can spawn child processes, read auxiliary files, or
/// follow symbolic links. It is an argument-validation layer, not a replacement for the platform
/// sandbox that enforces the directory filesystem and network boundary.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BuiltInRipgrepPolicy;

impl BuiltInRipgrepPolicy {
    pub fn validate(&self, request: &ShellCommandRequest) -> Result<(), RipgrepRequestError> {
        let mut options_ended = false;
        for argument in request.arguments() {
            if options_ended {
                continue;
            }
            if argument == "--" {
                options_ended = true;
                continue;
            }
            if is_forbidden_option(argument) {
                return Err(RipgrepRequestError::UnsafeArgument(argument.clone()));
            }
        }
        Ok(())
    }
}

/// Frozen absolute identity of the ripgrep executable selected at host startup.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RipgrepExecutable {
    path: PathBuf,
}

impl RipgrepExecutable {
    /// Selects and freezes the first valid path from a host-provided candidate sequence.
    pub fn discover_candidates(
        candidates: impl IntoIterator<Item = impl AsRef<Path>>,
    ) -> Result<Self, RipgrepDiscoveryError> {
        for candidate in candidates {
            if let Ok(executable) = Self::from_path(candidate) {
                return Ok(executable);
            }
        }
        Err(RipgrepDiscoveryError::NotFound)
    }

    /// Validates an authoritative environment override without falling back to another candidate.
    pub fn from_override(
        variable: &'static str,
        path: impl AsRef<Path>,
    ) -> Result<Self, RipgrepDiscoveryError> {
        Self::from_path(path).map_err(|error| RipgrepDiscoveryError::InvalidOverride {
            variable,
            reason: error.to_string(),
        })
    }

    /// Freezes one explicit ripgrep executable path.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, RipgrepDiscoveryError> {
        let path = path.as_ref();
        let metadata = path
            .metadata()
            .map_err(|error| RipgrepDiscoveryError::InvalidExecutable(error.to_string()))?;
        if !metadata.is_file() {
            return Err(RipgrepDiscoveryError::InvalidExecutable(
                "ripgrep candidate is not a regular file".into(),
            ));
        }
        #[cfg(unix)]
        if std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
            return Err(RipgrepDiscoveryError::InvalidExecutable(
                "ripgrep candidate is not executable".into(),
            ));
        }
        let path = path
            .canonicalize()
            .map_err(|error| RipgrepDiscoveryError::InvalidExecutable(error.to_string()))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Replaces the model-visible `rg` alias with the frozen executable and disables config files.
    pub fn materialize(
        &self,
        request: ShellCommandRequest,
    ) -> Result<ShellCommandRequest, RipgrepRequestError> {
        if request.program() != "rg" {
            return Err(RipgrepRequestError::UnsupportedProgram(
                request.program().to_owned(),
            ));
        }
        BuiltInRipgrepPolicy.validate(&request)?;
        let mut arguments = Vec::with_capacity(request.arguments().len() + 1);
        arguments.push("--no-config".to_owned());
        arguments.extend(request.arguments().iter().cloned());
        Ok(request
            .replace_program_and_arguments(self.path.to_string_lossy().into_owned(), arguments))
    }
}

fn is_forbidden_option(argument: &str) -> bool {
    if argument.starts_with("--") {
        return argument == "--pre"
            || argument.starts_with("--pre=")
            || argument == "--pre-glob"
            || argument.starts_with("--pre-glob=")
            || argument == "--hostname-bin"
            || argument.starts_with("--hostname-bin=")
            || argument == "--file"
            || argument.starts_with("--file=")
            || argument == "--ignore-file"
            || argument.starts_with("--ignore-file=")
            || argument == "--search-zip"
            || argument == "--follow";
    }
    if !argument.starts_with('-') || argument == "-" {
        return false;
    }
    short_option_cluster_is_forbidden(&argument[1..])
}

fn short_option_cluster_is_forbidden(cluster: &str) -> bool {
    for option in cluster.chars() {
        if matches!(option, 'f' | 'L' | 'z') {
            return true;
        }
        if short_option_takes_value(option) {
            return false;
        }
    }
    false
}

fn short_option_takes_value(option: char) -> bool {
    matches!(
        option,
        'A' | 'B' | 'C' | 'E' | 'M' | 'T' | 'd' | 'e' | 'f' | 'g' | 'j' | 'm' | 'r' | 't'
    )
}

/// Failure to locate and freeze the product ripgrep executable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RipgrepDiscoveryError {
    NotFound,
    InvalidExecutable(String),
    InvalidOverride {
        variable: &'static str,
        reason: String,
    },
}

impl fmt::Display for RipgrepDiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => formatter
                .write_str("ripgrep was not found in the host-provided installation candidates"),
            Self::InvalidExecutable(reason) => {
                write!(formatter, "invalid ripgrep executable: {reason}")
            }
            Self::InvalidOverride { variable, reason } => {
                write!(formatter, "{variable} does not identify ripgrep: {reason}")
            }
        }
    }
}

impl std::error::Error for RipgrepDiscoveryError {}

/// Rejection of a command that is not within Ash's read-only ripgrep profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RipgrepRequestError {
    UnsupportedProgram(String),
    UnsafeArgument(String),
}

impl fmt::Display for RipgrepRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProgram(program) => {
                write!(
                    formatter,
                    "only the frozen `rg` program is available, got `{program}`"
                )
            }
            Self::UnsafeArgument(argument) => {
                write!(formatter, "ripgrep argument is not allowed: {argument}")
            }
        }
    }
}

impl std::error::Error for RipgrepRequestError {}

#[cfg(test)]
#[path = "ripgrep_tests.rs"]
mod tests;
