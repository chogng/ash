//! Host-provided environment context shown by one Session Pane.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionPaneContext {
    location: String,
    working_directory: String,
    git_branch: String,
    diff_summary: String,
}

impl SessionPaneContext {
    pub fn new(
        location: impl Into<String>,
        working_directory: impl Into<String>,
        git_branch: impl Into<String>,
        diff_summary: impl Into<String>,
    ) -> Self {
        Self {
            location: location.into(),
            working_directory: working_directory.into(),
            git_branch: git_branch.into(),
            diff_summary: diff_summary.into(),
        }
    }

    pub fn location(&self) -> &str {
        &self.location
    }

    pub fn working_directory(&self) -> &str {
        &self.working_directory
    }

    pub fn git_branch(&self) -> &str {
        &self.git_branch
    }

    pub fn diff_summary(&self) -> &str {
        &self.diff_summary
    }

    pub fn metadata(&self) -> String {
        format!(
            "{}  ·  {}  ·  {}  ·  {}",
            self.location, self.working_directory, self.git_branch, self.diff_summary
        )
    }
}
