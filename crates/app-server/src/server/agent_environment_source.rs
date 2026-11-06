use ash_agent_environment::AgentEnvironmentError;
use ash_agent_environment::AgentEnvironmentSnapshot;
use ash_agent_environment::Dirs;
use ash_agent_environment::HostEnvironment;
use ash_agent_environment::RepositoryEnvironment;
use ash_file_access::Authorization;
use ash_file_access::Grant;
use ash_file_access::Permission;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::OnceLock;

const MAX_GIT_STATUS_LINES: usize = 40;

pub(super) enum RepositoryInspection {
    Allowed,
    Omit,
    OnSnapshot(Authorization),
}

#[derive(Clone)]
enum RepositorySource {
    Captured(RepositoryEnvironment),
    Authorized(Arc<AuthorizedRepository>),
}

struct AuthorizedRepository {
    authorization: Authorization,
    snapshot: OnceLock<Result<RepositoryEnvironment, AgentEnvironmentError>>,
}

impl RepositorySource {
    fn authorized(authorization: Authorization) -> Self {
        Self::Authorized(Arc::new(AuthorizedRepository {
            authorization,
            snapshot: OnceLock::new(),
        }))
    }
}

/// App Server-owned collection of immutable host and repository facts.
#[derive(Clone)]
pub(super) struct AgentEnvironmentSource {
    host: HostEnvironment,
    repository: RepositorySource,
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
        if !matches!(repository_inspection, RepositoryInspection::Omit) {
            return Self::capture(path, repository_inspection);
        }
        Ok(Self {
            host: HostEnvironment::new(
                path.to_path_buf(),
                self.host.platform().to_owned(),
                self.host.os_version().to_owned(),
                self.host.shell().to_owned(),
            )?,
            repository: RepositorySource::Captured(RepositoryEnvironment::NotDetected),
        })
    }

    pub(super) fn capture(
        dir_root: &Path,
        repository_inspection: RepositoryInspection,
    ) -> Result<Self, AgentEnvironmentError> {
        let repository = match repository_inspection {
            RepositoryInspection::Allowed => {
                RepositorySource::Captured(capture_repository(dir_root)?)
            }
            RepositoryInspection::Omit => {
                RepositorySource::Captured(RepositoryEnvironment::NotDetected)
            }
            RepositoryInspection::OnSnapshot(authorization) => {
                RepositorySource::authorized(authorization)
            }
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

    pub(super) fn replace_repository_grant(&mut self, grant: &Grant) {
        self.repository = grant
            .authorize(Permission::InspectRepository)
            .map(RepositorySource::authorized)
            .unwrap_or(RepositorySource::Captured(
                RepositoryEnvironment::NotDetected,
            ));
    }

    pub(super) fn snapshot(
        &self,
        dirs: impl IntoIterator<Item = PathBuf>,
    ) -> Result<AgentEnvironmentSnapshot, AgentEnvironmentError> {
        let dirs = Dirs::new(dirs)?;
        Ok(AgentEnvironmentSnapshot::new(
            self.host.clone(),
            self.repository()?,
            dirs,
        ))
    }

    fn repository(&self) -> Result<RepositoryEnvironment, AgentEnvironmentError> {
        match &self.repository {
            RepositorySource::Captured(repository) => Ok(repository.clone()),
            RepositorySource::Authorized(repository) => {
                let authorization = &repository.authorization;
                let dir = authorization.dir();
                // The directory grant owns the read, including reuse of the cached snapshot.
                authorization
                    .execute(
                        authorization.subject(),
                        dir,
                        Permission::InspectRepository,
                        || {
                            repository
                                .snapshot
                                .get_or_init(|| capture_repository(dir.canonical_path()))
                                .clone()
                        },
                    )
                    .unwrap_or(Ok(RepositoryEnvironment::NotDetected))
            }
        }
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
