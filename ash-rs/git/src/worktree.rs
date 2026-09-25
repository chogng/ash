use std::path::Path;
use std::path::PathBuf;

use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::objects::validate_checkout_path;
use crate::path::path_from_git_bytes;
use std::ffi::OsString;

/// Whether one Git worktree inventory entry can be opened now.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitWorktreeAvailability {
    Ready,
    Locked { reason: Option<String> },
    Prunable { reason: Option<String> },
}

impl GitWorktreeAvailability {
    pub const fn is_available(&self) -> bool {
        matches!(self, Self::Ready | Self::Locked { .. })
    }
}

/// One entry returned by `git worktree list --porcelain -z`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitWorktree {
    checkout_root: PathBuf,
    head: String,
    branch: Option<String>,
    availability: GitWorktreeAvailability,
}

/// Inputs for creating one detached linked worktree at an immutable commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDetachedWorktreeRequest {
    checkout_root: PathBuf,
    start_object_id: String,
}

/// Inputs for creating a linked worktree on one new local branch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitNamedWorktreeRequest {
    checkout_root: PathBuf,
    start_object_id: String,
    branch_name: String,
}

impl GitNamedWorktreeRequest {
    pub fn new(
        checkout_root: PathBuf,
        start_object_id: String,
        branch_name: String,
    ) -> GitResult<Self> {
        let detached = GitDetachedWorktreeRequest::new(checkout_root, start_object_id)?;
        if branch_name.trim().is_empty() {
            return Err(GitError::InvalidConfiguration {
                field: "worktree branch name",
                requirement: "must not be empty",
            });
        }
        Ok(Self {
            checkout_root: detached.checkout_root,
            start_object_id: detached.start_object_id,
            branch_name,
        })
    }
}

impl GitDetachedWorktreeRequest {
    pub fn new(checkout_root: PathBuf, start_object_id: String) -> GitResult<Self> {
        let checkout_root = validate_checkout_path(&checkout_root)?;
        if !(40..=64).contains(&start_object_id.len())
            || !start_object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidConfiguration {
                field: "worktree start object",
                requirement: "must be a hexadecimal Git commit ID",
            });
        }
        Ok(Self {
            checkout_root,
            start_object_id,
        })
    }

    pub fn checkout_root(&self) -> &Path {
        &self.checkout_root
    }
}

/// Explicit acknowledgement that a linked worktree is safe to remove with all local contents.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitWorktreeRemovalMode {
    DiscardVerifiedContents,
}

impl GitWorktree {
    pub fn checkout_root(&self) -> &Path {
        &self.checkout_root
    }

    pub fn head(&self) -> &str {
        &self.head
    }

    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    pub const fn availability(&self) -> &GitWorktreeAvailability {
        &self.availability
    }
}

impl GitClient {
    /// Lists every primary, linked, locked, and prunable worktree for one repository.
    pub async fn worktrees(&self, repository: &GitRepository) -> GitResult<Vec<GitWorktree>> {
        let output = self
            .run_query(
                repository.worktree_root(),
                ["worktree", "list", "--porcelain", "-z"],
            )
            .await?;
        parse_worktrees(&output.stdout, &output.command)
    }

    /// Creates a detached linked worktree without checking out files.
    pub async fn create_detached_worktree(
        &self,
        repository: &GitRepository,
        request: &GitDetachedWorktreeRequest,
    ) -> GitResult<GitRepository> {
        let arguments = vec![
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("--detach"),
            OsString::from("--no-checkout"),
            request.checkout_root.as_os_str().to_owned(),
            OsString::from(&request.start_object_id),
        ];
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        self.open_repository(&request.checkout_root).await
    }

    /// Creates a detached linked worktree with its files checked out for direct use.
    pub async fn create_detached_checkout(
        &self,
        repository: &GitRepository,
        request: &GitDetachedWorktreeRequest,
    ) -> GitResult<GitRepository> {
        let arguments = vec![
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("--detach"),
            request.checkout_root.as_os_str().to_owned(),
            OsString::from(&request.start_object_id),
        ];
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        self.open_repository(&request.checkout_root).await
    }

    /// Creates a linked worktree and a new branch as one Git operation.
    pub async fn create_named_worktree(
        &self,
        repository: &GitRepository,
        request: &GitNamedWorktreeRequest,
    ) -> GitResult<GitRepository> {
        self.run_query(
            repository.worktree_root(),
            [
                "check-ref-format",
                &format!("refs/heads/{}", request.branch_name),
            ],
        )
        .await?
        .require_success()?;
        let arguments = vec![
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("--no-checkout"),
            OsString::from("-b"),
            OsString::from(&request.branch_name),
            request.checkout_root.as_os_str().to_owned(),
            OsString::from(&request.start_object_id),
        ];
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        self.open_repository(&request.checkout_root).await
    }

    /// Locks a managed worktree so Git cleanup cannot prune it while its Thread is retained.
    pub async fn lock_worktree(
        &self,
        repository: &GitRepository,
        checkout_root: &Path,
        reason: &str,
    ) -> GitResult<()> {
        if reason.trim().is_empty() {
            return Err(GitError::InvalidConfiguration {
                field: "worktree lock reason",
                requirement: "must not be empty",
            });
        }
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("worktree"),
                OsString::from("lock"),
                OsString::from("--reason"),
                OsString::from(reason),
                checkout_root.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Repairs the administrative links for one existing linked worktree after a repository move.
    pub async fn repair_linked_worktree(
        &self,
        repository: &GitRepository,
        checkout_root: &Path,
    ) -> GitResult<()> {
        if !checkout_root.is_absolute() || checkout_root == repository.worktree_root() {
            return Err(GitError::InvalidConfiguration {
                field: "linked worktree repair path",
                requirement: "must identify another absolute checkout",
            });
        }
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("worktree"),
                OsString::from("repair"),
                checkout_root.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        let repaired = self.open_repository(checkout_root).await?;
        if repaired.kind() != crate::GitRepositoryKind::LinkedWorktree
            || repaired.common_dir() != repository.common_dir()
        {
            return Err(GitError::invalid_output(
                "git worktree repair",
                "repaired checkout does not belong to the source repository",
            ));
        }
        Ok(())
    }

    /// Unlocks one managed worktree immediately before an approved removal.
    pub async fn unlock_worktree(
        &self,
        repository: &GitRepository,
        checkout_root: &Path,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("worktree"),
                OsString::from("unlock"),
                checkout_root.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Removes one linked worktree after the ledger owner has verified discard eligibility.
    pub async fn remove_linked_worktree(
        &self,
        repository: &GitRepository,
        checkout_root: &Path,
        _mode: GitWorktreeRemovalMode,
    ) -> GitResult<()> {
        if !checkout_root.is_absolute() || checkout_root == repository.worktree_root() {
            return Err(GitError::InvalidConfiguration {
                field: "linked worktree removal path",
                requirement: "must identify another absolute checkout",
            });
        }
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("worktree"),
                OsString::from("remove"),
                OsString::from("--force"),
                checkout_root.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }
}

fn parse_worktrees(output: &[u8], command: &str) -> GitResult<Vec<GitWorktree>> {
    if !output.is_empty() && !output.ends_with(b"\0\0") {
        return Err(GitError::invalid_output(
            command,
            "worktree list omitted its final record separator",
        ));
    }
    let mut result = Vec::new();
    let mut checkout_root = None;
    let mut head = None;
    let mut branch = None;
    let mut availability = GitWorktreeAvailability::Ready;
    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(checkout_root) = checkout_root.take() {
                result.push(GitWorktree {
                    checkout_root,
                    head: head.take().ok_or_else(|| {
                        GitError::invalid_output(command, "worktree record omitted HEAD")
                    })?,
                    branch: branch.take(),
                    availability,
                });
                availability = GitWorktreeAvailability::Ready;
            }
            continue;
        }
        if let Some(value) = field.strip_prefix(b"worktree ") {
            if checkout_root.is_some() {
                return Err(GitError::invalid_output(
                    command,
                    "worktree record omitted its separator",
                ));
            }
            checkout_root = Some(path_from_git_bytes(value, command)?);
        } else if let Some(value) = field.strip_prefix(b"HEAD ") {
            require_worktree_start(checkout_root.as_deref(), command)?;
            head = Some(text_field(value, command, "worktree HEAD")?);
        } else if let Some(value) = field.strip_prefix(b"branch refs/heads/") {
            require_worktree_start(checkout_root.as_deref(), command)?;
            branch = Some(text_field(value, command, "worktree branch")?);
        } else if field == b"detached" || field == b"bare" {
            require_worktree_start(checkout_root.as_deref(), command)?;
        } else if let Some(value) = field.strip_prefix(b"locked") {
            require_worktree_start(checkout_root.as_deref(), command)?;
            availability = GitWorktreeAvailability::Locked {
                reason: optional_reason(value, command, "worktree lock reason")?,
            };
        } else if let Some(value) = field.strip_prefix(b"prunable") {
            require_worktree_start(checkout_root.as_deref(), command)?;
            availability = GitWorktreeAvailability::Prunable {
                reason: optional_reason(value, command, "worktree prune reason")?,
            };
        } else {
            return Err(GitError::invalid_output(
                command,
                format!("unknown worktree field: {}", String::from_utf8_lossy(field)),
            ));
        }
    }
    if checkout_root.is_some() {
        return Err(GitError::invalid_output(
            command,
            "worktree list omitted its final record separator",
        ));
    }
    Ok(result)
}

fn require_worktree_start(checkout_root: Option<&Path>, command: &str) -> GitResult<()> {
    if checkout_root.is_none() {
        return Err(GitError::invalid_output(
            command,
            "worktree record field appeared before its path",
        ));
    }
    Ok(())
}

fn text_field(value: &[u8], command: &str, label: &str) -> GitResult<String> {
    std::str::from_utf8(value)
        .map(ToOwned::to_owned)
        .map_err(|_| GitError::invalid_output(command, format!("{label} was not UTF-8")))
}

fn optional_reason(value: &[u8], command: &str, label: &str) -> GitResult<Option<String>> {
    value
        .strip_prefix(b" ")
        .filter(|value| !value.is_empty())
        .map(|value| text_field(value, command, label))
        .transpose()
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;
