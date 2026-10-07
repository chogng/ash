use super::validate_object_id;
use crate::GitClient;
use crate::GitCommitRequest;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::GitTreeId;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::PathBuf;

/// Result of replaying one immutable tree delta onto another immutable tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitTreeReplayResult {
    Clean(GitTreeId),
    Conflict { paths: Vec<PathBuf> },
}

impl GitClient {
    /// Resolves one commit-ish to its immutable tree object.
    pub async fn resolve_tree(
        &self,
        repository: &GitRepository,
        revision: &str,
    ) -> GitResult<GitTreeId> {
        validate_object_id(revision, "tree source revision")?;
        self.commit_tree(repository, revision).await
    }

    /// Replays `before -> after` onto `current` without changing refs, indexes, or files.
    pub async fn replay_tree_delta(
        &self,
        repository: &GitRepository,
        before: &GitTreeId,
        current: &GitTreeId,
        after: &GitTreeId,
    ) -> GitResult<GitTreeReplayResult> {
        Ok(
            match self.merge_trees(repository, before, current, after).await? {
                MergeTreeResult::Clean(tree) => GitTreeReplayResult::Clean(tree),
                MergeTreeResult::Conflict(paths) => GitTreeReplayResult::Conflict { paths },
            },
        )
    }

    /// Builds `before` plus exactly the selected immutable file changes. A rename selects both
    /// paths together; no file is read from the checkout or the real index.
    pub async fn select_tree_changes(
        &self,
        repository: &GitRepository,
        before: &GitTreeId,
        after: &GitTreeId,
        paths: &[PathBuf],
    ) -> GitResult<GitTreeId> {
        let selected = paths.iter().collect::<BTreeSet<_>>();
        if selected.is_empty() || selected.len() != paths.len() {
            return Err(GitError::InvalidConfiguration {
                field: "tree change selection",
                requirement: "must contain distinct changed paths",
            });
        }
        let changes = self
            .diff_trees(repository, before, after)
            .await?
            .into_iter()
            .filter(|change| selected.contains(&change.path().to_path_buf()))
            .collect::<Vec<_>>();
        if changes.len() != paths.len() {
            return Err(GitError::InvalidConfiguration {
                field: "tree change selection",
                requirement: "must identify changes in the immutable delta",
            });
        }
        self.apply_tree_changes(repository, before, changes).await
    }

    async fn apply_tree_changes(
        &self,
        repository: &GitRepository,
        current: &GitTreeId,
        changes: Vec<crate::GitTreeChange>,
    ) -> GitResult<GitTreeId> {
        let temporary = temporary_index(repository)?;
        self.run_mutation_with_index(
            repository.worktree_root(),
            ["read-tree", current.as_str()],
            temporary.path(),
        )
        .await?
        .require_success()?;
        for change in changes {
            if let Some(previous) = change.previous_path()
                && previous != change.path()
            {
                self.run_mutation_with_index(
                    repository.worktree_root(),
                    [
                        OsString::from("update-index"),
                        OsString::from("--force-remove"),
                        OsString::from("--"),
                        previous.as_os_str().to_owned(),
                    ],
                    temporary.path(),
                )
                .await?
                .require_success()?;
            }
            match (change.after_mode(), change.after_object_id()) {
                (Some(mode), Some(object_id)) => {
                    self.run_mutation_with_index(
                        repository.worktree_root(),
                        [
                            OsString::from("update-index"),
                            OsString::from("--add"),
                            OsString::from("--cacheinfo"),
                            OsString::from(mode),
                            OsString::from(object_id),
                            change.path().as_os_str().to_owned(),
                        ],
                        temporary.path(),
                    )
                    .await?
                    .require_success()?;
                }
                (None, None) => {
                    self.run_mutation_with_index(
                        repository.worktree_root(),
                        [
                            OsString::from("update-index"),
                            OsString::from("--force-remove"),
                            OsString::from("--"),
                            change.path().as_os_str().to_owned(),
                        ],
                        temporary.path(),
                    )
                    .await?
                    .require_success()?;
                }
                _ => {
                    return Err(GitError::invalid_output(
                        "compose immutable tree delta",
                        "tree change has incomplete object metadata",
                    ));
                }
            }
        }
        let output = self
            .run_mutation_with_index(repository.worktree_root(), ["write-tree"], temporary.path())
            .await?
            .require_success()?;
        parse_tree(output.stdout, &output.command)
    }

    async fn commit_tree(&self, repository: &GitRepository, commit: &str) -> GitResult<GitTreeId> {
        let revision = format!("{commit}^{{tree}}");
        let output = self
            .run_query(
                repository.worktree_root(),
                ["rev-parse", "--verify", &revision],
            )
            .await?;
        parse_tree(output.stdout, &output.command)
    }

    async fn merge_trees(
        &self,
        repository: &GitRepository,
        base: &GitTreeId,
        current: &GitTreeId,
        incoming: &GitTreeId,
    ) -> GitResult<MergeTreeResult> {
        // Tree-only commits give merge-tree an explicit base without borrowing branch ancestry.
        // This preserves unselected paths while allowing Git's text merge to apply disjoint edits.
        let message = GitCommitRequest::new("Ash immutable tree merge".into())?;
        let base_commit = self
            .create_deterministic_commit(repository, base, None, &message)
            .await?;
        let current_commit = self
            .create_deterministic_commit(repository, current, None, &message)
            .await?;
        let incoming_commit = self
            .create_deterministic_commit(repository, incoming, None, &message)
            .await?;
        let output = self
            .run_mutation(
                repository.worktree_root(),
                [
                    "merge-tree",
                    "--write-tree",
                    "--name-only",
                    "-z",
                    &format!("--merge-base={base_commit}"),
                    &current_commit,
                    &incoming_commit,
                ],
            )
            .await?;
        if !matches!(output.status.code(), Some(0 | 1)) {
            return match output.require_success() {
                Ok(_) => unreachable!("merge status was checked"),
                Err(error) => Err(error),
            };
        }
        let mut fields = output.stdout.split(|byte| *byte == 0);
        let tree = fields.next().ok_or_else(|| {
            GitError::invalid_output(&output.command, "merge-tree omitted its tree")
        })?;
        let tree = parse_tree(tree.to_vec(), &output.command)?;
        if output.status.success() {
            return Ok(MergeTreeResult::Clean(tree));
        }
        let paths = fields
            .take_while(|field| !field.is_empty())
            .map(|path| crate::path::path_from_git_bytes(path, &output.command))
            .collect::<GitResult<Vec<_>>>()?;
        Ok(MergeTreeResult::Conflict(paths))
    }

    async fn create_deterministic_commit(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
        parent: Option<&str>,
        message: &GitCommitRequest,
    ) -> GitResult<String> {
        let mut arguments = vec!["-c", "user.name=Ash Integration"];
        arguments.extend(["-c", "user.email=ash-integration@invalid", "commit-tree"]);
        arguments.push(tree.as_str());
        if let Some(parent) = parent {
            arguments.extend(["-p", parent]);
        }
        arguments.extend(["-F", "-"]);
        let output = self
            .run_mutation_with_stdin_and_environment(
                repository.worktree_root(),
                arguments,
                message.message().as_bytes().to_vec(),
                [
                    ("GIT_AUTHOR_DATE", "@1 +0000"),
                    ("GIT_COMMITTER_DATE", "@1 +0000"),
                ],
            )
            .await?
            .require_success()?;
        let object_id = String::from_utf8(output.stdout)
            .map_err(|_| GitError::invalid_output(&output.command, "commit ID was not UTF-8"))?
            .trim()
            .to_string();
        validate_object_id(&object_id, "commit ID")?;
        Ok(object_id)
    }

    /// Creates a user-authored commit object at the preparation time captured by its owner.
    pub async fn create_commit_object(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
        parent: Option<&str>,
        message: &GitCommitRequest,
        timestamp: u64,
    ) -> GitResult<String> {
        let mut arguments = vec!["commit-tree", tree.as_str()];
        if let Some(parent) = parent {
            arguments.extend(["-p", parent]);
        }
        arguments.extend(["-F", "-"]);
        let date = format!("@{timestamp} +0000");
        let output = self
            .run_mutation_with_stdin_and_environment(
                repository.worktree_root(),
                arguments,
                message.message().as_bytes().to_vec(),
                [
                    ("GIT_AUTHOR_DATE", date.as_str()),
                    ("GIT_COMMITTER_DATE", date.as_str()),
                ],
            )
            .await?
            .require_success()?;
        let object_id = String::from_utf8(output.stdout)
            .map_err(|_| GitError::invalid_output(&output.command, "commit ID was not UTF-8"))?
            .trim()
            .to_owned();
        validate_object_id(&object_id, "commit ID")?;
        Ok(object_id)
    }
}

enum MergeTreeResult {
    Clean(GitTreeId),
    Conflict(Vec<PathBuf>),
}

fn temporary_index(repository: &GitRepository) -> GitResult<tempfile::NamedTempFile> {
    let temporary = tempfile::Builder::new()
        .prefix("ash-merge-index-")
        .tempfile_in(repository.common_dir())
        .map_err(|source| GitError::io("create temporary Git merge index", source))?;
    std::fs::remove_file(temporary.path())
        .map_err(|source| GitError::io("prepare temporary Git merge index", source))?;
    Ok(temporary)
}

pub(crate) fn parse_tree(output: Vec<u8>, command: &str) -> GitResult<GitTreeId> {
    let value = String::from_utf8(output)
        .map_err(|_| GitError::invalid_output(command, "tree object ID was not UTF-8"))?;
    GitTreeId::new(value.trim().to_string())
}

#[cfg(test)]
#[path = "tree_tests.rs"]
mod tests;
