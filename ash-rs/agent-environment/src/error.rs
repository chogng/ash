use ash_utils_absolute_path::AbsolutePathBuf;
use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
/// Rejects invalid host facts before they enter a model-visible environment snapshot.
pub enum AgentEnvironmentError {
    InvalidTime { message: String },
    EmptyPath { field: &'static str },
    PathMustBeAbsolute { field: &'static str, value: String },
    EmptyValue { field: &'static str },
}

impl fmt::Display for AgentEnvironmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTime { message } => formatter.write_str(message),
            Self::EmptyPath { field } => write!(formatter, "{field} must not be empty"),
            Self::PathMustBeAbsolute { field, value } => {
                write!(formatter, "{field} must be an absolute path: {value}")
            }
            Self::EmptyValue { field } => write!(formatter, "{field} must not be empty"),
        }
    }
}

impl std::error::Error for AgentEnvironmentError {}

pub(crate) fn absolute_path(
    field: &'static str,
    value: PathBuf,
) -> Result<AbsolutePathBuf, AgentEnvironmentError> {
    if value.as_os_str().is_empty() {
        return Err(AgentEnvironmentError::EmptyPath { field });
    }
    AbsolutePathBuf::from_absolute(&value).map_err(|_| AgentEnvironmentError::PathMustBeAbsolute {
        field,
        value: value.display().to_string(),
    })
}

pub(crate) fn validate_text(field: &'static str, value: &str) -> Result<(), AgentEnvironmentError> {
    if value.trim().is_empty() {
        return Err(AgentEnvironmentError::EmptyValue { field });
    }
    Ok(())
}
