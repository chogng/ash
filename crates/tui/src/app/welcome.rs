pub(super) mod pet;

use crate::models::ModelSummary;
use std::path::Path;

/// Display-only context for the Thread identity header.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WelcomeModel {
    directory: String,
    model: String,
}

impl WelcomeModel {
    pub(crate) fn for_workspace(workspace_root: &Path) -> Self {
        Self {
            directory: format_directory(workspace_root, dirs::home_dir().as_deref()),
            model: "Automatic model".into(),
        }
    }

    pub(crate) fn apply_model_summary(&mut self, summary: &ModelSummary) {
        self.model = summary.model_label();
    }

    pub(crate) fn directory(&self) -> &str {
        &self.directory
    }

    pub(super) fn model_line(&self) -> String {
        self.model.clone()
    }
}

fn format_directory(directory: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home
        && let Ok(relative) = directory.strip_prefix(home)
    {
        return if relative.as_os_str().is_empty() {
            "~".into()
        } else {
            format!("~{}{}", std::path::MAIN_SEPARATOR, relative.display())
        };
    }
    directory.display().to_string()
}

#[cfg(test)]
#[path = "welcome_model_tests.rs"]
mod model_tests;
