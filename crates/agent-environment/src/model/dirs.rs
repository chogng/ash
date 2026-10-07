use crate::AgentEnvironmentError;
use crate::error::absolute_path;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::path::PathBuf;

/// Sorted, deduplicated directories visible to the Agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dirs {
    entries: Vec<AbsolutePathBuf>,
}

impl Dirs {
    pub fn new(dirs: impl IntoIterator<Item = PathBuf>) -> Result<Self, AgentEnvironmentError> {
        let mut entries = dirs
            .into_iter()
            .map(|dir| absolute_path("accessible directory", dir))
            .collect::<Result<Vec<_>, AgentEnvironmentError>>()?;
        entries.sort();
        entries.dedup();
        Ok(Self { entries })
    }

    pub fn as_slice(&self) -> &[AbsolutePathBuf] {
        &self.entries
    }
}

#[cfg(test)]
#[path = "dirs_tests.rs"]
mod tests;
