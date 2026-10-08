use std::ffi::OsString;
use std::path::Component;
use std::path::PathBuf;

use crate::GitClient;
use crate::GitError;
use crate::GitHead;
use crate::GitRepository;
use crate::GitResult;

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
    scope: CommitScope,
    mode: CommitMode,
    signoff: CommitSignoff,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommitScope {
    Staged,
    Tracked,
    IncludeUntracked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommitMode {
    Create,
    Amend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommitSignoff {
    None,
    Add,
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
        Ok(Self {
            message,
            scope: CommitScope::Staged,
            mode: CommitMode::Create,
            signoff: CommitSignoff::None,
        })
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn with_tracked_changes(mut self) -> Self {
        self.scope = CommitScope::Tracked;
        self
    }

    pub fn with_untracked_changes(mut self) -> Self {
        self.scope = CommitScope::IncludeUntracked;
        self
    }

    pub fn amend(mut self) -> Self {
        self.mode = CommitMode::Amend;
        self
    }

    pub fn sign_off(mut self) -> Self {
        self.signoff = CommitSignoff::Add;
        self
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

    /// Commits the requested scope with hooks disabled by the mutation profile.
    pub async fn commit(
        &self,
        repository: &GitRepository,
        request: &GitCommitRequest,
    ) -> GitResult<GitCommitResult> {
        self.commit_output(repository, request)
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
}

#[cfg(test)]
#[path = "mutation_tests.rs"]
mod tests;

impl GitClient {
    pub(crate) async fn amend_commit(
        &self,
        repository: &GitRepository,
        message: &str,
    ) -> GitResult<crate::client::GitCommandOutput> {
        let request = GitCommitRequest::new(message.to_string())?.amend();
        self.commit_output(repository, &request).await
    }

    async fn commit_output(
        &self,
        repository: &GitRepository,
        request: &GitCommitRequest,
    ) -> GitResult<crate::client::GitCommandOutput> {
        // An all-changes intent must not stage unresolved conflict markers as a resolution.
        if self
            .snapshot(repository)
            .await?
            .changes()
            .iter()
            .any(|change| change.is_conflicted())
        {
            return Err(GitError::InvalidConfiguration {
                field: "commit",
                requirement: "must resolve all conflicts before committing",
            });
        }
        let root = repository.worktree_root();
        match request.scope {
            CommitScope::Staged => {}
            CommitScope::Tracked => {
                self.run_mutation(root, ["add", "--update", "--", "."])
                    .await?
                    .require_success()?;
            }
            CommitScope::IncludeUntracked => {
                self.run_mutation(root, ["add", "--all", "--", "."])
                    .await?
                    .require_success()?;
            }
        }
        let mut arguments = vec!["commit", "--file=-"];
        match request.mode {
            CommitMode::Create => {}
            CommitMode::Amend => arguments.push("--amend"),
        }
        match request.signoff {
            CommitSignoff::None => {}
            CommitSignoff::Add => arguments.push("--signoff"),
        }
        self.run_mutation_with_stdin(root, arguments, request.message().as_bytes().to_vec())
            .await
    }
}
