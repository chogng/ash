use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::path::path_from_git_bytes;

/// One path changed by a commit relative to its first parent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitChange {
    path: PathBuf,
    original_path: Option<PathBuf>,
    status: GitChangeStatus,
}

impl GitCommitChange {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn original_path(&self) -> Option<&Path> {
        self.original_path.as_deref()
    }

    pub fn status(&self) -> GitChangeStatus {
        self.status
    }
}

/// The before/after bytes used to open one committed path in an editor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitFile {
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
}

impl GitCommitFile {
    pub fn original(&self) -> Option<&[u8]> {
        self.original.as_deref()
    }

    pub fn modified(&self) -> Option<&[u8]> {
        self.modified.as_deref()
    }
}

/// Whether history compares two trees or changes since their common ancestor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitComparisonMode {
    Direct,
    MergeBase,
}

/// Commit metadata and first-parent change totals, read only when details are requested.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitDetails {
    pub author_name: String,
    pub author_email: String,
    pub timestamp_seconds: i64,
    pub message: String,
    pub statistics: GitCommitStatistics,
}

/// Binary paths contribute to the file count, but have no added or deleted line count.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GitCommitStatistics {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}

impl GitClient {
    /// Uses the same first-parent comparison as history expansion, including root and merge commits.
    pub async fn commit_details(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<GitCommitDetails> {
        validate_object_id(object_id)?;
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "show",
                    "--first-parent",
                    "--numstat",
                    "--find-renames",
                    "-z",
                    "--format=format:%an%x00%ae%x00%ct%x00%B%x00",
                    object_id,
                    "--",
                ],
            )
            .await?;
        let mut fields = output.stdout.splitn(5, |byte| *byte == 0);
        let mut text = || -> GitResult<String> {
            let value = fields.next().ok_or_else(|| {
                GitError::invalid_output(&output.command, "commit details omitted metadata")
            })?;
            std::str::from_utf8(value).map(str::to_owned).map_err(|_| {
                GitError::invalid_output(&output.command, "commit details were not UTF-8")
            })
        };
        let author_name = text()?;
        let author_email = text()?;
        let timestamp_seconds = text()?.parse().map_err(|_| {
            GitError::invalid_output(&output.command, "commit timestamp was invalid")
        })?;
        let message = text()?.trim_end_matches('\n').to_owned();
        let statistics = fields.next().ok_or_else(|| {
            GitError::invalid_output(&output.command, "commit details omitted statistics")
        })?;
        let statistics = statistics.strip_prefix(b"\n").unwrap_or(statistics);
        Ok(GitCommitDetails {
            author_name,
            author_email,
            timestamp_seconds,
            message,
            statistics: crate::objects::commit_statistics(statistics, &output.command)?,
        })
    }

    /// Lists files changed by a commit relative to its first parent.
    ///
    /// Root commits are compared with the empty tree. Merge commits intentionally use their first
    /// parent, matching the history-item expansion shown by common Git workbench UIs.
    pub async fn commit_changes(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<(Option<String>, Vec<GitCommitChange>)> {
        validate_object_id(object_id)?;
        let parent_object_id = self.first_parent(repository, object_id).await?;
        let output = if let Some(parent) = parent_object_id.as_deref() {
            self.run_query(
                repository.worktree_root(),
                [
                    OsString::from("diff"),
                    OsString::from("--name-status"),
                    OsString::from("--find-renames"),
                    OsString::from("-z"),
                    OsString::from(parent),
                    OsString::from(object_id),
                    OsString::from("--"),
                ],
            )
            .await?
        } else {
            self.run_query(
                repository.worktree_root(),
                [
                    OsString::from("diff-tree"),
                    OsString::from("--root"),
                    OsString::from("--no-commit-id"),
                    OsString::from("--name-status"),
                    OsString::from("--find-renames"),
                    OsString::from("-r"),
                    OsString::from("-z"),
                    OsString::from(object_id),
                    OsString::from("--"),
                ],
            )
            .await?
        };
        Ok((
            parent_object_id,
            parse_commit_changes(&output.stdout, &output.command)?,
        ))
    }

    /// Compares immutable commits; the base may be a ref selected by the user.
    pub async fn compare_changes(
        &self,
        repository: &GitRepository,
        object_id: &str,
        base_reference: &str,
        mode: GitComparisonMode,
    ) -> GitResult<(String, Vec<GitCommitChange>)> {
        validate_object_id(object_id)?;
        let base = self.resolve_commit(repository, base_reference).await?;
        let base = match mode {
            GitComparisonMode::Direct => base,
            GitComparisonMode::MergeBase => {
                let output = self
                    .run_query(repository.worktree_root(), ["merge-base", &base, object_id])
                    .await?;
                let base = String::from_utf8_lossy(&output.stdout).trim().to_string();
                validate_object_id(&base)?;
                base
            }
        };
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "diff",
                    "--name-status",
                    "--find-renames",
                    "-z",
                    &base,
                    object_id,
                    "--",
                ],
            )
            .await?;
        Ok((base, parse_commit_changes(&output.stdout, &output.command)?))
    }

    pub async fn commit_message(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<String> {
        validate_object_id(object_id)?;
        let output = self
            .run_query(
                repository.worktree_root(),
                ["show", "--no-patch", "--format=%B", object_id, "--"],
            )
            .await?;
        String::from_utf8(output.stdout)
            .map(|message| message.trim_end_matches('\n').to_owned())
            .map_err(|_| GitError::invalid_output(output.command, "commit message was not UTF-8"))
    }

    /// Reads the before/after bytes for one changed path at a commit and its first parent.
    pub async fn commit_file(
        &self,
        repository: &GitRepository,
        object_id: &str,
        parent_object_id: Option<&str>,
        path: &Path,
        original_path: Option<&Path>,
        maximum_bytes: usize,
    ) -> GitResult<GitCommitFile> {
        validate_object_id(object_id)?;
        if let Some(parent) = parent_object_id {
            validate_object_id(parent)?;
        }
        validate_relative_path(path)?;
        if let Some(original_path) = original_path {
            validate_relative_path(original_path)?;
        }
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
        let original = match parent_object_id {
            Some(parent) => {
                self.read_file_at_object(
                    repository,
                    original_path.unwrap_or(path),
                    parent,
                    maximum_bytes,
                )
                .await?
            }
            None => None,
        };
        let modified = self
            .read_file_at_object(repository, path, object_id, maximum_bytes)
            .await?;
        Ok(GitCommitFile { original, modified })
    }

    async fn first_parent(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<Option<String>> {
        let output = self
            .run_query(
                repository.worktree_root(),
                ["rev-list", "--parents", "-n", "1", object_id],
            )
            .await?;
        let text = std::str::from_utf8(&output.stdout).map_err(|_| {
            GitError::invalid_output(&output.command, "commit parent output was not UTF-8")
        })?;
        let mut fields = text.split_whitespace();
        let commit = fields.next().ok_or_else(|| {
            GitError::invalid_output(&output.command, "commit parent output was empty")
        })?;
        if commit != object_id {
            return Err(GitError::invalid_output(
                &output.command,
                "commit parent output did not begin with the requested object",
            ));
        }
        Ok(fields.next().map(str::to_string))
    }

    async fn read_file_at_object(
        &self,
        repository: &GitRepository,
        path: &Path,
        object_id: &str,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        let mut object = OsString::from(object_id);
        object.push(":");
        object.push(path);
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("show"),
                    OsString::from("--no-textconv"),
                    object,
                ],
            )
            .await?;
        if !output.status.success() {
            return if missing_object(&output.stderr) {
                Ok(None)
            } else {
                Err(GitError::CommandFailed {
                    command: output.command,
                    exit_code: output.status.code(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            };
        }
        if output.stdout.len() > maximum_bytes {
            return Err(GitError::OutputLimitExceeded {
                command: output.command,
                stream: "stdout",
                limit_bytes: maximum_bytes,
            });
        }
        Ok(Some(output.stdout))
    }
}

fn parse_commit_changes(bytes: &[u8], command: &str) -> GitResult<Vec<GitCommitChange>> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(status_field) = fields.next() {
        let status_text = std::str::from_utf8(status_field)
            .map_err(|_| GitError::invalid_output(command, "commit change status was not UTF-8"))?;
        let status_code =
            status_text.as_bytes().first().copied().ok_or_else(|| {
                GitError::invalid_output(command, "commit change status was empty")
            })?;
        let status = parse_status(status_code, command)?;
        let first_path = fields
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "commit change omitted its path"))?;
        let (path, original_path) = if matches!(status_code, b'R' | b'C') {
            let path = fields.next().ok_or_else(|| {
                GitError::invalid_output(
                    command,
                    "renamed commit change omitted its destination path",
                )
            })?;
            (
                path_from_git_bytes(path, command)?,
                Some(path_from_git_bytes(first_path, command)?),
            )
        } else {
            (path_from_git_bytes(first_path, command)?, None)
        };
        changes.push(GitCommitChange {
            path,
            original_path,
            status,
        });
    }
    Ok(changes)
}

fn parse_status(code: u8, command: &str) -> GitResult<GitChangeStatus> {
    match code {
        b'M' => Ok(GitChangeStatus::Modified),
        b'A' => Ok(GitChangeStatus::Added),
        b'D' => Ok(GitChangeStatus::Deleted),
        b'R' => Ok(GitChangeStatus::Renamed),
        b'C' => Ok(GitChangeStatus::Copied),
        b'T' => Ok(GitChangeStatus::TypeChanged),
        b'U' => Ok(GitChangeStatus::Unmerged),
        _ => Err(GitError::invalid_output(
            command,
            format!("unknown commit change status {}", char::from(code)),
        )),
    }
}

fn validate_object_id(object_id: &str) -> GitResult<()> {
    if !(40..=64).contains(&object_id.len())
        || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitError::runtime(
            "validate Git object id",
            "object id must be a 40-64 character hexadecimal hash",
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> GitResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(GitError::runtime(
            "validate Git commit path",
            "path must be a non-empty normalized repository-relative path",
        ));
    }
    Ok(())
}

fn missing_object(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    stderr.contains("does not exist in")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("Path '")
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

mod graph;

pub use graph::GitGraph;
pub use graph::GitGraphCursor;
pub use graph::GitReference;
pub use graph::GitReferenceKind;
pub use summary::GitCommitSummary;
mod summary;
