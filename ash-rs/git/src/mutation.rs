use std::ffi::OsString;
use std::path::{Component, PathBuf};

use crate::{GitBranch, GitClient, GitError, GitHead, GitRepository, GitResult};

const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;

/// Validated repository-relative paths targeted by one explicit Git mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPathspecSet {
    paths: Vec<PathBuf>,
}

impl GitPathspecSet {
    pub fn new(paths: Vec<PathBuf>) -> GitResult<Self> {
        if paths.is_empty() {
            return Err(GitError::InvalidConfiguration {
                field: "paths",
                requirement: "must contain at least one path",
            });
        }
        if paths.iter().any(|path| {
            path.as_os_str().is_empty()
                || path.as_os_str().to_string_lossy().contains('\0')
                || path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
        }) {
            return Err(GitError::InvalidConfiguration {
                field: "paths",
                requirement: "must contain only non-empty repository-relative paths",
            });
        }
        Ok(Self { paths })
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    fn arguments(&self, prefix: &[&str]) -> Vec<OsString> {
        prefix
            .iter()
            .map(|argument| OsString::from(*argument))
            .chain(std::iter::once(OsString::from("--")))
            .chain(self.paths.iter().map(|path| path.as_os_str().to_owned()))
            .collect()
    }
}

/// Validated commit message passed to Git over stdin rather than argv.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitRequest {
    message: String,
}

impl GitCommitRequest {
    pub fn new(message: String) -> GitResult<Self> {
        if message.trim().is_empty() {
            return Err(GitError::InvalidConfiguration {
                field: "commit message",
                requirement: "must not be empty",
            });
        }
        if message.len() > MAX_COMMIT_MESSAGE_BYTES || message.contains('\0') {
            return Err(GitError::InvalidConfiguration {
                field: "commit message",
                requirement: "must be NUL-free and no larger than 64 KiB",
            });
        }
        Ok(Self { message })
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Identity returned after Git has durably created one commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitResult {
    object_id: String,
}

impl GitCommitResult {
    pub fn object_id(&self) -> &str {
        &self.object_id
    }
}

impl GitClient {
    /// Switches the working tree to one local branch returned by [`GitClient::local_branches`].
    ///
    /// Git remains authoritative for dirty-worktree and linked-worktree conflicts. A rejected
    /// switch is returned as [`GitError::CommandFailed`] without retrying or discarding changes.
    pub async fn switch_branch(
        &self,
        repository: &GitRepository,
        branch: &GitBranch,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("switch"),
                OsString::from("--"),
                OsString::from(branch.name()),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Adds the selected repository-relative paths to the index.
    pub async fn stage(&self, repository: &GitRepository, paths: &GitPathspecSet) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), paths.arguments(&["add"]))
            .await?
            .require_success()?;
        Ok(())
    }

    /// Restores the selected index entries from HEAD, including the unborn-HEAD case.
    pub async fn unstage(
        &self,
        repository: &GitRepository,
        paths: &GitPathspecSet,
    ) -> GitResult<()> {
        let snapshot = self.snapshot(repository).await?;
        let arguments = match snapshot.head() {
            GitHead::Unborn { .. } => {
                paths.arguments(&["rm", "--cached", "-r", "--ignore-unmatch"])
            }
            GitHead::Branch { .. } | GitHead::Detached { .. } => {
                paths.arguments(&["restore", "--staged"])
            }
        };
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        Ok(())
    }

    /// Discards tracked working-tree changes for the selected paths.
    ///
    /// Untracked files are never deleted by this operation.
    pub async fn discard_worktree(
        &self,
        repository: &GitRepository,
        paths: &GitPathspecSet,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            paths.arguments(&["restore", "--worktree"]),
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Creates one commit from the current index with hooks disabled by the mutation profile.
    pub async fn commit(
        &self,
        repository: &GitRepository,
        request: &GitCommitRequest,
    ) -> GitResult<GitCommitResult> {
        self.run_mutation_with_stdin(
            repository.worktree_root(),
            ["commit", "--file=-"],
            request.message.as_bytes().to_vec(),
        )
        .await?
        .require_success()?;
        let output = self
            .run_query(
                repository.worktree_root(),
                ["rev-parse", "--verify", "HEAD"],
            )
            .await?;
        let command = output.command;
        let object_id = String::from_utf8(output.stdout)
            .map_err(|_| GitError::invalid_output(command.clone(), "commit ID is not UTF-8"))?
            .trim()
            .to_string();
        if object_id.is_empty() {
            return Err(GitError::invalid_output(command, "commit ID is empty"));
        }
        Ok(GitCommitResult { object_id })
    }

    /// Fetches the current branch's default remote without interactive credential prompts.
    pub async fn fetch_default(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["fetch", "--prune"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Fetches and prunes every configured remote without interactive credential prompts.
    pub async fn fetch(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["fetch", "--all", "--prune"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Pulls the configured upstream only when it can fast-forward.
    pub async fn pull_fast_forward(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["pull", "--ff-only"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Pushes the current branch to its configured upstream.
    pub async fn push(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["push"])
            .await?
            .require_success()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "mutation_tests.rs"]
mod tests;
