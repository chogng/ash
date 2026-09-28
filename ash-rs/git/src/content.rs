use std::ffi::OsString;
use std::path::Path;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitRepositoryChange;
use crate::GitResult;
use crate::GitTreeId;

/// Repository revision from which a host wants to read one file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitFileRevision {
    /// The file recorded by the current `HEAD` commit.
    Head,
    /// The file currently recorded in the index.
    Index,
    /// Common ancestor recorded in stage 1 of an unmerged index entry.
    MergeBase,
    /// Our version recorded in stage 2 of an unmerged index entry.
    MergeCurrent,
    /// Their version recorded in stage 3 of an unmerged index entry.
    MergeIncoming,
}

/// Selects the canonical two-sided comparison for one current repository change.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitChangeFileComparison {
    /// Compares the current `HEAD` commit with the index.
    Staged,
    /// Compares the index with the working tree.
    Unstaged,
}

/// Bounded before/after bytes used to open one current repository change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeFile {
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
}

/// The three index stages and editable worktree result of one conflict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitConflictFile {
    stage_ids: [Option<String>; 3],
    result_object_id: Option<String>,
    base: Option<Vec<u8>>,
    current: Option<Vec<u8>>,
    incoming: Option<Vec<u8>>,
    result: Option<Vec<u8>>,
}

/// Explicit index-stage choice for a whole-file conflict resolution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitConflictChoice {
    Current,
    Incoming,
    Delete,
}

impl GitConflictFile {
    pub fn stage_ids(&self) -> &[Option<String>; 3] {
        &self.stage_ids
    }
    pub fn result_object_id(&self) -> Option<&str> {
        self.result_object_id.as_deref()
    }
    pub fn base(&self) -> Option<&[u8]> {
        self.base.as_deref()
    }
    pub fn current(&self) -> Option<&[u8]> {
        self.current.as_deref()
    }
    pub fn incoming(&self) -> Option<&[u8]> {
        self.incoming.as_deref()
    }
    pub fn result(&self) -> Option<&[u8]> {
        self.result.as_deref()
    }
}

impl GitChangeFile {
    pub fn original(&self) -> Option<&[u8]> {
        self.original.as_deref()
    }

    pub fn modified(&self) -> Option<&[u8]> {
        self.modified.as_deref()
    }
}

impl GitClient {
    /// Reads one repository-relative file at a named Git revision.
    ///
    /// Missing paths, including every path in an unborn `HEAD`, return `Ok(None)`. Hosts use this
    /// distinction to build added and deleted file diffs without parsing Git diagnostics.
    pub async fn read_file_at_revision(
        &self,
        repository: &GitRepository,
        path: &Path,
        revision: GitFileRevision,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        let object_prefix = match revision {
            GitFileRevision::Head => OsString::from("HEAD:"),
            GitFileRevision::Index => OsString::from(":"),
            GitFileRevision::MergeBase => OsString::from(":1:"),
            GitFileRevision::MergeCurrent => OsString::from(":2:"),
            GitFileRevision::MergeIncoming => OsString::from(":3:"),
        };
        self.read_content_object(repository, path, object_prefix, maximum_bytes)
            .await
    }

    /// Reads one path from an exact immutable tree object.
    pub async fn read_file_at_tree(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
        path: &Path,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        let mut object_prefix = OsString::from(tree.as_str());
        object_prefix.push(":");
        self.read_content_object(repository, path, object_prefix, maximum_bytes)
            .await
    }

    async fn read_content_object(
        &self,
        repository: &GitRepository,
        path: &Path,
        mut object: OsString,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        validate_relative_path(path)?;
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
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

    /// Reads the exact sides represented by a staged or unstaged status resource.
    pub async fn change_file(
        &self,
        repository: &GitRepository,
        change: &GitRepositoryChange,
        comparison: GitChangeFileComparison,
        maximum_bytes: usize,
    ) -> GitResult<GitChangeFile> {
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
        let original_path = comparison_original_path(change, comparison);
        let original = self
            .read_file_at_revision(
                repository,
                original_path,
                match comparison {
                    GitChangeFileComparison::Staged => GitFileRevision::Head,
                    GitChangeFileComparison::Unstaged => GitFileRevision::Index,
                },
                maximum_bytes,
            )
            .await?;
        let modified = match comparison {
            GitChangeFileComparison::Staged => {
                self.read_file_at_revision(
                    repository,
                    change.path(),
                    GitFileRevision::Index,
                    maximum_bytes,
                )
                .await?
            }
            GitChangeFileComparison::Unstaged => {
                read_worktree_file(repository, change.path(), maximum_bytes)?
            }
        };
        Ok(GitChangeFile { original, modified })
    }

    /// Reads the index stages and working file for a change that remains unmerged.
    pub async fn conflict_file(
        &self,
        repository: &GitRepository,
        change: &GitRepositoryChange,
        maximum_bytes: usize,
    ) -> GitResult<GitConflictFile> {
        if !change.is_conflicted() {
            return Err(GitError::runtime(
                "read Git conflict",
                "path is not conflicted",
            ));
        }
        let path = change.path();
        let stage_ids = self.conflict_stage_ids(repository, path).await?;
        if stage_ids[1].is_none() && stage_ids[2].is_none() {
            return Err(GitError::runtime(
                "read Git conflict",
                "index stages changed",
            ));
        }
        let base = self
            .read_file_at_revision(repository, path, GitFileRevision::MergeBase, maximum_bytes)
            .await?;
        let current = self
            .read_file_at_revision(
                repository,
                path,
                GitFileRevision::MergeCurrent,
                maximum_bytes,
            )
            .await?;
        let incoming = self
            .read_file_at_revision(
                repository,
                path,
                GitFileRevision::MergeIncoming,
                maximum_bytes,
            )
            .await?;
        if stage_ids[0].is_some() != base.is_some()
            || stage_ids[1].is_some() != current.is_some()
            || stage_ids[2].is_some() != incoming.is_some()
        {
            return Err(GitError::runtime(
                "read Git conflict",
                "index stages changed",
            ));
        }
        let result = read_worktree_file(repository, path, maximum_bytes)?;
        let result_object_id = if result.is_some() {
            Some(self.worktree_object_id(repository, path).await?)
        } else {
            None
        };
        Ok(GitConflictFile {
            stage_ids,
            result_object_id,
            base,
            current,
            incoming,
            result,
        })
    }

    async fn worktree_object_id(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<String> {
        validate_relative_path(path)?;
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("hash-object"),
                    OsString::from("--no-filters"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
        let object_id = std::str::from_utf8(&output.stdout)
            .map_err(|_| GitError::invalid_output("git hash-object", "invalid object id"))?
            .trim();
        if !matches!(object_id.len(), 40 | 64)
            || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::invalid_output(
                "git hash-object",
                "invalid object id",
            ));
        }
        Ok(object_id.to_owned())
    }

    async fn conflict_stage_ids(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<[Option<String>; 3]> {
        validate_relative_path(path)?;
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("ls-files"),
                    OsString::from("--stage"),
                    OsString::from("-z"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
        let mut stages = [None, None, None];
        for entry in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let Some(tab) = entry.iter().position(|byte| *byte == b'\t') else {
                return Err(GitError::invalid_output(
                    "git ls-files --stage",
                    "missing stage path",
                ));
            };
            if crate::path::path_from_git_bytes(&entry[tab + 1..], "git ls-files --stage")? != path
            {
                continue;
            }
            let metadata = std::str::from_utf8(&entry[..tab]).map_err(|_| {
                GitError::invalid_output("git ls-files --stage", "invalid stage metadata")
            })?;
            let mut fields = metadata.split(' ');
            let _mode = fields.next();
            let object_id = fields.next().ok_or_else(|| {
                GitError::invalid_output("git ls-files --stage", "missing stage object")
            })?;
            let stage = fields.next().ok_or_else(|| {
                GitError::invalid_output("git ls-files --stage", "missing stage number")
            })?;
            let index = match stage {
                "1" => 0,
                "2" => 1,
                "3" => 2,
                _ => continue,
            };
            if !matches!(object_id.len(), 40 | 64)
                || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(GitError::invalid_output(
                    "git ls-files --stage",
                    "invalid stage object",
                ));
            }
            stages[index] = Some(object_id.to_owned());
        }
        Ok(stages)
    }

    /// Applies one validated conflict result while the repository operation lock is held.
    pub async fn complete_conflict(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<()> {
        validate_relative_path(path)?;
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("--literal-pathspecs"),
                OsString::from("add"),
                OsString::from("--"),
                path.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Writes the selected index stage to the worktree, or keeps its deletion, then stages it.
    pub async fn choose_conflict_side(
        &self,
        repository: &GitRepository,
        path: &Path,
        choice: GitConflictChoice,
    ) -> GitResult<()> {
        validate_relative_path(path)?;
        if choice != GitConflictChoice::Delete {
            self.run_mutation(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("checkout"),
                    OsString::from(if choice == GitConflictChoice::Current {
                        "--ours"
                    } else {
                        "--theirs"
                    }),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
            self.complete_conflict(repository, path).await
        } else {
            self.run_mutation(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("rm"),
                    OsString::from("-f"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
            Ok(())
        }
    }
}

fn comparison_original_path(
    change: &GitRepositoryChange,
    comparison: GitChangeFileComparison,
) -> &Path {
    let status = match comparison {
        GitChangeFileComparison::Staged => change.index_status(),
        GitChangeFileComparison::Unstaged => change.worktree_status(),
    };
    if matches!(status, GitChangeStatus::Renamed | GitChangeStatus::Copied) {
        change.original_path().unwrap_or_else(|| change.path())
    } else {
        change.path()
    }
}

fn read_worktree_file(
    repository: &GitRepository,
    path: &Path,
    maximum_bytes: usize,
) -> GitResult<Option<Vec<u8>>> {
    validate_relative_path(path)?;
    let absolute_path = repository.worktree_root().join(path);
    let metadata = match absolute_path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(GitError::io("inspect Git working-tree file", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(GitError::runtime(
            "read Git working-tree file",
            "path is not a regular file",
        ));
    }
    if metadata.len() > maximum_bytes as u64 {
        return Err(GitError::OutputLimitExceeded {
            command: format!("read working-tree file {}", path.to_string_lossy()),
            stream: "file",
            limit_bytes: maximum_bytes,
        });
    }
    std::fs::read(absolute_path)
        .map(Some)
        .map_err(|error| GitError::io("read Git working-tree file", error))
}

fn validate_relative_path(path: &Path) -> GitResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(GitError::runtime(
            "validate Git file path",
            "path must be a non-empty repository-relative path",
        ));
    }
    Ok(())
}

fn missing_object(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    stderr.contains("does not exist in")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("invalid object name")
        || stderr.contains("unknown revision")
        || stderr.contains("bad revision")
        || stderr.contains("Path '")
        || stderr.contains("but not at stage")
        || stderr.contains("not in the index")
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
