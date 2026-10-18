use ash_agent_environment::AgentEnvironmentError;
use ash_agent_environment::AgentEnvironmentSnapshot;
use ash_agent_environment::Dirs;
use ash_agent_environment::HostEnvironment;
use ash_agent_environment::RepositoryEnvironment;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

const MAX_GIT_STATUS_LINES: usize = 40;

#[derive(Clone, Copy)]
pub(super) enum RepositoryInspection {
    Allowed,
    Omit,
}

/// App Server-owned collection of immutable host and repository facts.
#[derive(Clone)]
pub(super) struct AgentEnvironmentSource {
    host: HostEnvironment,
    repository: RepositoryEnvironment,
}

impl AgentEnvironmentSource {
    pub(super) fn cwd(&self) -> &Path {
        self.host.cwd()
    }

    pub(super) fn for_directory(
        &self,
        path: &Path,
        repository_inspection: RepositoryInspection,
    ) -> Result<Self, AgentEnvironmentError> {
        if matches!(repository_inspection, RepositoryInspection::Allowed) {
            return Self::capture(path, repository_inspection);
        }
        Ok(Self {
            host: HostEnvironment::new(
                path.to_path_buf(),
                self.host.platform().to_owned(),
                self.host.os_version().to_owned(),
                self.host.shell().to_owned(),
            )?,
            repository: RepositoryEnvironment::NotDetected,
        })
    }

    pub(super) fn capture(
        dir_root: &Path,
        repository_inspection: RepositoryInspection,
    ) -> Result<Self, AgentEnvironmentError> {
        let repository = match repository_inspection {
            RepositoryInspection::Allowed => capture_repository(dir_root)?,
            RepositoryInspection::Omit => RepositoryEnvironment::NotDetected,
        };
        let host = HostEnvironment::new(
            dir_root.to_path_buf(),
            platform_name().into(),
            command_output(dir_root, "uname", &["-sr"])
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "unknown".into()),
            std::env::var("SHELL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "unknown".into()),
        )?;
        Ok(Self { host, repository })
    }

    pub(super) fn snapshot(
        &self,
        dirs: impl IntoIterator<Item = PathBuf>,
    ) -> Result<AgentEnvironmentSnapshot, AgentEnvironmentError> {
        let dirs = Dirs::new(dirs)?;
        Ok(AgentEnvironmentSnapshot::new(
            self.host.clone(),
            self.repository.clone(),
            dirs,
        ))
    }
}

fn truncate_lines(text: &str, maximum_lines: usize) -> String {
    let mut lines = text.lines().take(maximum_lines).collect::<Vec<_>>();
    if text.lines().count() > maximum_lines {
        lines.push("[... git status truncated ...]");
    }
    if lines.is_empty() {
        "(clean)".into()
    } else {
        lines.join("\n")
    }
}

fn command_output(dir_root: &Path, program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(arguments)
        .current_dir(dir_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn capture_repository(dir_root: &Path) -> Result<RepositoryEnvironment, AgentEnvironmentError> {
    // InspectRepository does not authorize executing repository-configured programs.
    // Keep process identity, query hardening, and resource limits in the shared Git owner.
    let summary = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .and_then(|runtime| {
            runtime
                .block_on(crate::git_service::current_client().environment_summary(dir_root))
                .ok()
        });
    let Some(summary) = summary else {
        return Ok(RepositoryEnvironment::NotDetected);
    };
    RepositoryEnvironment::git(
        summary.branch,
        summary.main_branch,
        summary
            .status
            .map(|value| truncate_lines(&value, MAX_GIT_STATUS_LINES))
            .unwrap_or_else(|| "(none)".into()),
        summary.recent_commits.unwrap_or_else(|| "(none)".into()),
    )
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

#[cfg(test)]
#[path = "agent_environment_source_tests.rs"]
mod tests;
