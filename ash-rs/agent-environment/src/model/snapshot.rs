use crate::AgentEnvironmentError;
use crate::Dirs;
use crate::error::absolute_path;
use crate::error::validate_text;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::path::Path;
use std::path::PathBuf;

/// Host facts captured for one environment connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostEnvironment {
    cwd: AbsolutePathBuf,
    platform: String,
    os_version: String,
    shell: String,
}

impl HostEnvironment {
    /// Validates and freezes the host facts supplied by the embedding application.
    pub fn new(
        cwd: PathBuf,
        platform: String,
        os_version: String,
        shell: String,
    ) -> Result<Self, AgentEnvironmentError> {
        let cwd = absolute_path("cwd", cwd)?;
        validate_text("platform", &platform)?;
        validate_text("os version", &os_version)?;
        validate_text("shell", &shell)?;
        Ok(Self {
            cwd,
            platform,
            os_version,
            shell,
        })
    }

    /// Returns the primary working directory without changing it.
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Returns the stable platform identifier.
    pub fn platform(&self) -> &str {
        &self.platform
    }

    /// Returns the captured operating-system version summary.
    pub fn os_version(&self) -> &str {
        &self.os_version
    }

    /// Returns the captured user shell.
    pub fn shell(&self) -> &str {
        &self.shell
    }
}

/// Repository facts captured for one environment connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepositoryEnvironment {
    NotDetected,
    Git {
        branch: Option<String>,
        main_branch: Option<String>,
        status: String,
        recent_commits: String,
    },
}

impl RepositoryEnvironment {
    /// Validates and freezes a Git repository summary.
    pub fn git(
        branch: Option<String>,
        main_branch: Option<String>,
        status: String,
        recent_commits: String,
    ) -> Result<Self, AgentEnvironmentError> {
        if let Some(branch) = &branch {
            validate_text("Git branch", branch)?;
        }
        if let Some(main_branch) = &main_branch {
            validate_text("Git main branch", main_branch)?;
        }
        validate_text("Git status", &status)?;
        validate_text("Git recent commits", &recent_commits)?;
        Ok(Self::Git {
            branch,
            main_branch,
            status,
            recent_commits,
        })
    }
}

/// Complete immutable environment facts for one model invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentEnvironmentSnapshot {
    host: HostEnvironment,
    repository: RepositoryEnvironment,
    dirs: Dirs,
}

impl AgentEnvironmentSnapshot {
    /// Combines host, repository, and authorized directory facts.
    pub fn new(host: HostEnvironment, repository: RepositoryEnvironment, dirs: Dirs) -> Self {
        Self {
            host,
            repository,
            dirs,
        }
    }

    /// Returns the captured host facts.
    pub fn host(&self) -> &HostEnvironment {
        &self.host
    }

    /// Returns the captured repository facts.
    pub fn repository(&self) -> &RepositoryEnvironment {
        &self.repository
    }

    /// Returns the exact accessible directories visible for this invocation.
    pub fn dirs(&self) -> &Dirs {
        &self.dirs
    }
}
