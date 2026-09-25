use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{GitClient, GitCommitRequest, GitError, GitHead, GitRepository, GitResult, GitTreeId};
use serde::{Deserialize, Serialize};

/// Immutable Turn delta and the target branch revision observed when commit work starts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeCommitRequest {
    transaction_id: String,
    target_branch: String,
    expected_target_head: Option<String>,
    before_tree: GitTreeId,
    after_tree: GitTreeId,
    message: GitCommitRequest,
}

/// Exact final tree and target revision used to prepare a commit before any ref is changed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPreparedTreeCommitRequest {
    transaction_id: String,
    target_branch: String,
    expected_target_head: Option<String>,
    target_tree: GitTreeId,
    final_tree: GitTreeId,
    message: GitCommitRequest,
}

impl GitPreparedTreeCommitRequest {
    pub fn new(
        transaction_id: String,
        target_branch: String,
        expected_target_head: String,
        target_tree: GitTreeId,
        final_tree: GitTreeId,
        message: String,
    ) -> GitResult<Self> {
        validate_transaction_id(&transaction_id)?;
        validate_target_branch(&target_branch)?;
        validate_object_id(&expected_target_head, "expected target HEAD")?;
        Ok(Self {
            transaction_id,
            target_branch,
            expected_target_head: Some(expected_target_head),
            target_tree,
            final_tree,
            message: GitCommitRequest::new(message)?,
        })
    }

    pub fn new_unborn(
        transaction_id: String,
        target_branch: String,
        target_tree: GitTreeId,
        final_tree: GitTreeId,
        message: String,
    ) -> GitResult<Self> {
        validate_transaction_id(&transaction_id)?;
        validate_target_branch(&target_branch)?;
        Ok(Self {
            transaction_id,
            target_branch,
            expected_target_head: None,
            target_tree,
            final_tree,
            message: GitCommitRequest::new(message)?,
        })
    }

    pub fn target_branch(&self) -> &str {
        &self.target_branch
    }
}

/// Commit object built from a sealed tree for later conditional publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPreparedTreeCommit {
    transaction_id: String,
    target_branch: String,
    expected_target_head: Option<String>,
    target_tree: GitTreeId,
    final_tree: GitTreeId,
    object_id: String,
}

impl GitPreparedTreeCommit {
    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    pub fn target_branch(&self) -> &str {
        &self.target_branch
    }
}

impl GitTreeCommitRequest {
    pub fn new(
        transaction_id: String,
        target_branch: String,
        expected_target_head: String,
        before_tree: GitTreeId,
        after_tree: GitTreeId,
        message: String,
    ) -> GitResult<Self> {
        if transaction_id.is_empty()
            || transaction_id.len() > 128
            || !transaction_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(GitError::InvalidConfiguration {
                field: "transaction ID",
                requirement: "must contain only ASCII letters, digits, '-' or '_'",
            });
        }
        if target_branch.trim().is_empty()
            || target_branch.starts_with('-')
            || target_branch.contains(char::is_whitespace)
        {
            return Err(GitError::InvalidConfiguration {
                field: "target branch",
                requirement: "must identify one non-empty local branch",
            });
        }
        validate_object_id(&expected_target_head, "expected target HEAD")?;
        Ok(Self {
            transaction_id,
            target_branch,
            expected_target_head: Some(expected_target_head),
            before_tree,
            after_tree,
            message: GitCommitRequest::new(message)?,
        })
    }

    /// Builds the first commit request for a branch that still has no ref.
    pub fn new_unborn(
        transaction_id: String,
        target_branch: String,
        before_tree: GitTreeId,
        after_tree: GitTreeId,
        message: String,
    ) -> GitResult<Self> {
        let mut request = Self::new(
            transaction_id,
            target_branch,
            "0".repeat(40),
            before_tree,
            after_tree,
            message,
        )?;
        request.expected_target_head = None;
        Ok(request)
    }

    pub fn target_branch(&self) -> &str {
        &self.target_branch
    }
}

/// A replay conflict is distinct from a checkout that changed after transaction preparation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitTreeCommitConflict {
    ChangeSet { paths: Vec<PathBuf> },
    CheckoutChanged { paths: Vec<PathBuf> },
    TargetMoved,
    TargetDeleted,
    TargetDetached,
}

/// Result of committing one sealed tree delta without reading the managed Thread checkout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitTreeCommitResult {
    Committed { object_id: String },
    Conflict(GitTreeCommitConflict),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitPrepareTreeCommitResult {
    Prepared(GitPreparedTreeCommit),
    Conflict(GitTreeCommitConflict),
}

/// Result of replaying one immutable tree delta onto another immutable tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitTreeReplayResult {
    Clean(GitTreeId),
    Conflict { paths: Vec<PathBuf> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitTreeCommitRecovery {
    None,
    RolledBack,
    Committed { object_id: String },
    Conflict { paths: Vec<PathBuf> },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitJournal {
    version: u8,
    target_ref: String,
    old_head: Option<String>,
    new_head: String,
    checkout: Option<CheckoutJournal>,
    #[serde(default)]
    retain_until_acknowledged: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckoutJournal {
    root: PathBuf,
    original_index: String,
    original_worktree: String,
    desired_index: String,
    desired_worktree: String,
}

struct CheckoutState {
    repository: GitRepository,
    index_tree: GitTreeId,
    worktree_tree: GitTreeId,
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

    /// Completes or rolls back one interrupted immutable-tree commit from its durable journal.
    pub async fn recover_tree_commit(
        &self,
        repository: &GitRepository,
        transaction_id: &str,
    ) -> GitResult<GitTreeCommitRecovery> {
        let path = journal_path(repository, transaction_id)?;
        if !path.exists() {
            return Ok(GitTreeCommitRecovery::None);
        }
        let journal = read_journal(&path)?;
        let current = self
            .read_optional_ref(repository, &journal.target_ref)
            .await?;
        if current == journal.old_head {
            remove_journal(&path)?;
            return Ok(GitTreeCommitRecovery::RolledBack);
        }
        if current.as_deref() != Some(journal.new_head.as_str()) {
            return Ok(GitTreeCommitRecovery::Conflict { paths: Vec::new() });
        }
        let Some(checkout) = journal.checkout else {
            remove_completed_journal(&path, journal.retain_until_acknowledged)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        };
        let checkout_repository = self.open_repository(&checkout.root).await?;
        let current_index = self.capture_index_tree(&checkout_repository).await?;
        let current_worktree = self.capture_worktree_tree(&checkout_repository).await?;
        let desired_index = GitTreeId::new(checkout.desired_index)?;
        let desired_worktree = GitTreeId::new(checkout.desired_worktree)?;
        let original_index = GitTreeId::new(checkout.original_index)?;
        let original_worktree = GitTreeId::new(checkout.original_worktree)?;
        if current_index == desired_index && current_worktree == desired_worktree {
            remove_completed_journal(&path, journal.retain_until_acknowledged)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        }
        let install_can_resume = (current_index == original_index
            && current_worktree == original_worktree)
            || (current_index == desired_worktree && current_worktree == desired_worktree);
        if install_can_resume {
            self.install_checkout_state(&checkout_repository, &desired_worktree, &desired_index)
                .await?;
            remove_completed_journal(&path, journal.retain_until_acknowledged)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        }
        let paths = changed_paths(
            self.diff_trees(&checkout_repository, &original_worktree, &current_worktree)
                .await?,
        );
        Ok(GitTreeCommitRecovery::Conflict { paths })
    }

    /// Removes a retained prepared-publication journal after its publication receipt is durable.
    /// Calling this again after acknowledgement is harmless.
    pub async fn acknowledge_published_tree_commit(
        &self,
        repository: &GitRepository,
        transaction_id: &str,
        expected_object_id: &str,
    ) -> GitResult<()> {
        validate_object_id(expected_object_id, "published commit ID")?;
        let path = journal_path(repository, transaction_id)?;
        if !path.exists() {
            return Ok(());
        }
        let journal = read_journal(&path)?;
        if !journal.retain_until_acknowledged || journal.new_head != expected_object_id {
            return Err(GitError::runtime(
                "acknowledge prepared tree commit",
                "journal does not match the durable publication receipt",
            ));
        }
        remove_journal(&path)
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

    /// Creates a deterministic commit object for an exact verified final tree without changing a
    /// branch, index, or working tree.
    /// Creates a deterministic commit object without changing a branch, index or working tree.
    pub async fn prepare_commit_object(
        &self,
        repository: &GitRepository,
        parent: &str,
        tree: &GitTreeId,
        message: &str,
    ) -> GitResult<String> {
        let parent = self.resolve_commit(repository, parent).await?;
        self.create_deterministic_commit(
            repository,
            tree,
            Some(&parent),
            &GitCommitRequest::new(message.to_owned())?,
        )
        .await
    }

    pub async fn prepare_tree_commit(
        &self,
        repository: &GitRepository,
        request: &GitPreparedTreeCommitRequest,
    ) -> GitResult<GitPrepareTreeCommitResult> {
        self.validate_branch_name(repository, request.target_branch())
            .await?;
        let target_ref = format!("refs/heads/{}", request.target_branch);
        let target_head = self.read_optional_ref(repository, &target_ref).await?;
        if target_head != request.expected_target_head {
            return Ok(GitPrepareTreeCommitResult::Conflict(target_conflict(
                target_head.as_deref(),
                request.expected_target_head.as_deref(),
            )));
        }
        let target_tree = match target_head.as_deref() {
            Some(target_head) => self.commit_tree(repository, target_head).await?,
            None => self.empty_tree(repository).await?,
        };
        if target_tree != request.target_tree {
            return Ok(GitPrepareTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }
        let object_id = self
            .create_deterministic_commit(
                repository,
                &request.final_tree,
                target_head.as_deref(),
                &request.message,
            )
            .await?;
        Ok(GitPrepareTreeCommitResult::Prepared(
            GitPreparedTreeCommit {
                transaction_id: request.transaction_id.clone(),
                target_branch: request.target_branch.clone(),
                expected_target_head: request.expected_target_head.clone(),
                target_tree: request.target_tree.clone(),
                final_tree: request.final_tree.clone(),
                object_id,
            },
        ))
    }

    /// Publishes one previously prepared commit by compare-and-swap and preserves a checked-out
    /// target branch's staged and unstaged state through the same journaled transaction.
    pub async fn publish_prepared_tree_commit(
        &self,
        repository: &GitRepository,
        prepared: &GitPreparedTreeCommit,
    ) -> GitResult<GitTreeCommitResult> {
        self.validate_branch_name(repository, prepared.target_branch())
            .await?;
        let target_ref = format!("refs/heads/{}", prepared.target_branch);
        let target_head = self.read_optional_ref(repository, &target_ref).await?;
        if target_head != prepared.expected_target_head {
            return Ok(GitTreeCommitResult::Conflict(target_conflict(
                target_head.as_deref(),
                prepared.expected_target_head.as_deref(),
            )));
        }
        let target_tree = match target_head.as_deref() {
            Some(target_head) => self.commit_tree(repository, target_head).await?,
            None => self.empty_tree(repository).await?,
        };
        if target_tree != prepared.target_tree
            || self.commit_tree(repository, &prepared.object_id).await? != prepared.final_tree
        {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }

        let checkout = self
            .target_checkout(repository, prepared.target_branch())
            .await?;
        let checkout_update = match checkout.as_ref() {
            Some(state) => {
                let index_tree = match self
                    .merge_trees(
                        &state.repository,
                        &prepared.target_tree,
                        &prepared.final_tree,
                        &state.index_tree,
                    )
                    .await?
                {
                    MergeTreeResult::Clean(tree) => tree,
                    MergeTreeResult::Conflict(paths) => {
                        return Ok(GitTreeCommitResult::Conflict(
                            GitTreeCommitConflict::CheckoutChanged { paths },
                        ));
                    }
                };
                let worktree_tree = match self
                    .merge_trees(
                        &state.repository,
                        &state.index_tree,
                        &index_tree,
                        &state.worktree_tree,
                    )
                    .await?
                {
                    MergeTreeResult::Clean(tree) => tree,
                    MergeTreeResult::Conflict(paths) => {
                        return Ok(GitTreeCommitResult::Conflict(
                            GitTreeCommitConflict::CheckoutChanged { paths },
                        ));
                    }
                };
                Some((index_tree, worktree_tree))
            }
            None => None,
        };
        if let Some(state) = checkout.as_ref() {
            let snapshot = self.snapshot(&state.repository).await?;
            let target_still_checked_out = match snapshot.head() {
                GitHead::Branch { name, .. } => name == prepared.target_branch(),
                GitHead::Unborn { name } => {
                    prepared.expected_target_head.is_none() && name == prepared.target_branch()
                }
                GitHead::Detached { .. } => false,
            };
            if !target_still_checked_out {
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::TargetDetached,
                ));
            }
            let latest_index = self.capture_index_tree(&state.repository).await?;
            let latest_worktree = self.capture_worktree_tree(&state.repository).await?;
            if latest_index != state.index_tree || latest_worktree != state.worktree_tree {
                let paths = changed_paths(
                    self.diff_trees(&state.repository, &state.worktree_tree, &latest_worktree)
                        .await?,
                );
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::CheckoutChanged { paths },
                ));
            }
        }
        let latest_head = self.read_optional_ref(repository, &target_ref).await?;
        if latest_head != target_head {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }

        let journal_path = journal_path(repository, &prepared.transaction_id)?;
        let journal = CommitJournal {
            version: 3,
            target_ref: target_ref.clone(),
            old_head: target_head.clone(),
            new_head: prepared.object_id.clone(),
            checkout: checkout.as_ref().zip(checkout_update.as_ref()).map(
                |(state, (index_tree, worktree_tree))| CheckoutJournal {
                    root: state.repository.worktree_root().to_path_buf(),
                    original_index: state.index_tree.as_str().to_string(),
                    original_worktree: state.worktree_tree.as_str().to_string(),
                    desired_index: index_tree.as_str().to_string(),
                    desired_worktree: worktree_tree.as_str().to_string(),
                },
            ),
            retain_until_acknowledged: true,
        };
        write_journal(&journal_path, &journal)?;

        if let Err(error) = self
            .update_optional_ref_cas(
                repository,
                &target_ref,
                &prepared.object_id,
                target_head.as_deref(),
            )
            .await
        {
            let actual = self.read_optional_ref(repository, &target_ref).await?;
            if actual.as_deref() == Some(prepared.object_id.as_str()) {
                return match self
                    .recover_tree_commit(repository, &prepared.transaction_id)
                    .await?
                {
                    GitTreeCommitRecovery::Committed { object_id } => {
                        Ok(GitTreeCommitResult::Committed { object_id })
                    }
                    GitTreeCommitRecovery::Conflict { paths } => Ok(GitTreeCommitResult::Conflict(
                        GitTreeCommitConflict::CheckoutChanged { paths },
                    )),
                    GitTreeCommitRecovery::None | GitTreeCommitRecovery::RolledBack => {
                        Err(GitError::runtime(
                            "recover prepared tree commit after ref race",
                            "publication journal disappeared before recovery",
                        ))
                    }
                };
            }
            if actual != target_head {
                remove_journal(&journal_path)?;
                return Ok(GitTreeCommitResult::Conflict(target_conflict(
                    actual.as_deref(),
                    target_head.as_deref(),
                )));
            }
            return Err(error);
        }
        if let (Some(state), Some((index_tree, worktree_tree))) = (checkout, checkout_update)
            && let Err(error) = self
                .install_checkout_state(&state.repository, &worktree_tree, &index_tree)
                .await
        {
            let rollback = match target_head.as_deref() {
                Some(target_head) => {
                    self.update_ref_cas(repository, &target_ref, target_head, &prepared.object_id)
                        .await
                }
                None => {
                    self.delete_ref_cas(repository, &target_ref, &prepared.object_id)
                        .await
                }
            };
            let restore = self
                .install_checkout_state(&state.repository, &state.worktree_tree, &state.index_tree)
                .await;
            if rollback.is_err() || restore.is_err() {
                return Err(GitError::runtime(
                    "restore prepared tree commit transaction",
                    format!("install failed: {error}; repository requires transaction recovery"),
                ));
            }
            remove_journal(&journal_path)?;
            return Err(error);
        }
        Ok(GitTreeCommitResult::Committed {
            object_id: prepared.object_id.clone(),
        })
    }

    /// Applies only the paths changed by `before -> after` to `current`.
    ///
    /// This is used to rebuild a Thread worktree from the subset of its Turns that were
    /// committed; dependency validation has already excluded overlapping skipped Turns.
    pub async fn compose_tree_delta(
        &self,
        repository: &GitRepository,
        before: &GitTreeId,
        current: &GitTreeId,
        after: &GitTreeId,
    ) -> GitResult<GitTreeId> {
        let temporary = temporary_index(repository)?;
        self.run_mutation_with_index(
            repository.worktree_root(),
            ["read-tree", current.as_str()],
            temporary.path(),
        )
        .await?
        .require_success()?;
        for change in self.diff_trees(repository, before, after).await? {
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

    /// Replays one immutable ChangeSet onto a frozen branch revision and updates that branch by CAS.
    ///
    /// If the branch is checked out, staged, unstaged, and untracked state are separately replayed
    /// onto the new commit before any ref or checkout mutation occurs. Git hooks remain disabled.
    pub async fn commit_tree_delta(
        &self,
        repository: &GitRepository,
        request: &GitTreeCommitRequest,
    ) -> GitResult<GitTreeCommitResult> {
        self.validate_branch_name(repository, request.target_branch())
            .await?;
        if matches!(
            self.snapshot(repository).await?.head(),
            GitHead::Detached { .. }
        ) {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetDetached,
            ));
        }
        let target_ref = format!("refs/heads/{}", request.target_branch);
        let target_head = self.read_optional_ref(repository, &target_ref).await?;
        if target_head != request.expected_target_head {
            if target_head.is_none() && request.expected_target_head.is_some() {
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::TargetDeleted,
                ));
            }
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }

        let current_tree = match target_head.as_deref() {
            Some(target_head) => self.commit_tree(repository, target_head).await?,
            None => self.empty_tree(repository).await?,
        };
        let committed_tree = match self
            .replay_tree_delta(
                repository,
                &request.before_tree,
                &current_tree,
                &request.after_tree,
            )
            .await?
        {
            GitTreeReplayResult::Clean(tree) => tree,
            GitTreeReplayResult::Conflict { paths } => {
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::ChangeSet { paths },
                ));
            }
        };

        let checkout = self
            .target_checkout(repository, request.target_branch())
            .await?;
        let prepared = match checkout.as_ref() {
            Some(state) => {
                let index_tree = match self
                    .merge_trees(
                        &state.repository,
                        &current_tree,
                        &committed_tree,
                        &state.index_tree,
                    )
                    .await?
                {
                    MergeTreeResult::Clean(tree) => tree,
                    MergeTreeResult::Conflict(paths) => {
                        return Ok(GitTreeCommitResult::Conflict(
                            GitTreeCommitConflict::CheckoutChanged { paths },
                        ));
                    }
                };
                let worktree_tree = match self
                    .merge_trees(
                        &state.repository,
                        &state.index_tree,
                        &index_tree,
                        &state.worktree_tree,
                    )
                    .await?
                {
                    MergeTreeResult::Clean(tree) => tree,
                    MergeTreeResult::Conflict(paths) => {
                        return Ok(GitTreeCommitResult::Conflict(
                            GitTreeCommitConflict::CheckoutChanged { paths },
                        ));
                    }
                };
                Some((index_tree, worktree_tree))
            }
            None => None,
        };

        let object_id = self
            .create_commit(
                repository,
                &committed_tree,
                target_head.as_deref(),
                &request.message,
            )
            .await?;
        if let Some(state) = checkout.as_ref() {
            let snapshot = self.snapshot(&state.repository).await?;
            let target_still_checked_out = match snapshot.head() {
                GitHead::Branch { name, .. } => name == request.target_branch(),
                GitHead::Unborn { name } => {
                    request.expected_target_head.is_none() && name == request.target_branch()
                }
                GitHead::Detached { .. } => false,
            };
            if !target_still_checked_out {
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::TargetDetached,
                ));
            }
            let latest_index = self.capture_index_tree(&state.repository).await?;
            let latest_worktree = self.capture_worktree_tree(&state.repository).await?;
            if latest_index != state.index_tree || latest_worktree != state.worktree_tree {
                let paths = changed_paths(
                    self.diff_trees(&state.repository, &state.worktree_tree, &latest_worktree)
                        .await?,
                );
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::CheckoutChanged { paths },
                ));
            }
        }
        let latest_head = self.read_optional_ref(repository, &target_ref).await?;
        if latest_head != target_head {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }

        let journal_path = journal_path(repository, &request.transaction_id)?;
        let journal = CommitJournal {
            version: 2,
            target_ref: target_ref.clone(),
            old_head: target_head.clone(),
            new_head: object_id.clone(),
            checkout: checkout.as_ref().zip(prepared.as_ref()).map(
                |(state, (index_tree, worktree_tree))| CheckoutJournal {
                    root: state.repository.worktree_root().to_path_buf(),
                    original_index: state.index_tree.as_str().to_string(),
                    original_worktree: state.worktree_tree.as_str().to_string(),
                    desired_index: index_tree.as_str().to_string(),
                    desired_worktree: worktree_tree.as_str().to_string(),
                },
            ),
            retain_until_acknowledged: false,
        };
        write_journal(&journal_path, &journal)?;

        self.update_optional_ref_cas(repository, &target_ref, &object_id, target_head.as_deref())
            .await?;
        if let (Some(state), Some((index_tree, worktree_tree))) = (checkout, prepared)
            && let Err(error) = self
                .install_checkout_state(&state.repository, &worktree_tree, &index_tree)
                .await
        {
            let rollback = match target_head.as_deref() {
                Some(target_head) => {
                    self.update_ref_cas(repository, &target_ref, target_head, &object_id)
                        .await
                }
                None => {
                    self.delete_ref_cas(repository, &target_ref, &object_id)
                        .await
                }
            };
            let restore = self
                .install_checkout_state(&state.repository, &state.worktree_tree, &state.index_tree)
                .await;
            if rollback.is_err() || restore.is_err() {
                return Err(GitError::runtime(
                    "restore immutable tree commit transaction",
                    format!("install failed: {error}; repository requires transaction recovery"),
                ));
            }
            remove_journal(&journal_path)?;
            return Err(error);
        }
        remove_journal(&journal_path)?;
        Ok(GitTreeCommitResult::Committed { object_id })
    }

    async fn validate_branch_name(
        &self,
        repository: &GitRepository,
        branch: &str,
    ) -> GitResult<()> {
        self.run_query(
            repository.worktree_root(),
            ["check-ref-format", "--branch", branch],
        )
        .await?;
        Ok(())
    }

    async fn target_checkout(
        &self,
        repository: &GitRepository,
        branch: &str,
    ) -> GitResult<Option<CheckoutState>> {
        for worktree in self.worktrees(repository).await? {
            if worktree.branch() != Some(branch) {
                continue;
            }
            if !worktree.availability().is_available() {
                let tree = if worktree.head().bytes().all(|byte| byte == b'0') {
                    self.empty_tree(repository).await?
                } else {
                    self.commit_tree(repository, worktree.head()).await?
                };
                return Ok(Some(CheckoutState {
                    repository: self.open_repository(worktree.checkout_root()).await?,
                    index_tree: tree.clone(),
                    worktree_tree: tree,
                }));
            }
            let checkout = self.open_repository(worktree.checkout_root()).await?;
            let snapshot = self.snapshot(&checkout).await?;
            if !matches!(
                snapshot.head(),
                GitHead::Branch { name, .. } | GitHead::Unborn { name } if name == branch
            ) {
                return Err(GitError::runtime(
                    "prepare target checkout",
                    "target branch checkout became detached",
                ));
            }
            return Ok(Some(CheckoutState {
                index_tree: self.capture_index_tree(&checkout).await?,
                worktree_tree: self.capture_worktree_tree(&checkout).await?,
                repository: checkout,
            }));
        }
        Ok(None)
    }

    async fn capture_index_tree(&self, repository: &GitRepository) -> GitResult<GitTreeId> {
        let output = self
            .run_query(repository.worktree_root(), ["write-tree"])
            .await?;
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

    async fn read_optional_ref(
        &self,
        repository: &GitRepository,
        reference: &str,
    ) -> GitResult<Option<String>> {
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                ["rev-parse", "--verify", "--quiet", reference],
            )
            .await?;
        if !output.status.success() {
            return Ok(None);
        }
        let value = String::from_utf8(output.stdout)
            .map_err(|_| GitError::invalid_output(&output.command, "ref object ID was not UTF-8"))?
            .trim()
            .to_string();
        validate_object_id(&value, "ref object ID")?;
        Ok(Some(value))
    }

    async fn merge_trees(
        &self,
        repository: &GitRepository,
        base: &GitTreeId,
        current: &GitTreeId,
        incoming: &GitTreeId,
    ) -> GitResult<MergeTreeResult> {
        let temporary = temporary_index(repository)?;
        let output = self
            .run_mutation_with_index(
                repository.worktree_root(),
                [
                    "read-tree",
                    "-m",
                    base.as_str(),
                    current.as_str(),
                    incoming.as_str(),
                ],
                temporary.path(),
            )
            .await?;
        let paths = self.unmerged_paths(repository, temporary.path()).await?;
        if !paths.is_empty() {
            return Ok(MergeTreeResult::Conflict(paths));
        }
        if !output.status.success() {
            return match output.require_success() {
                Ok(_) => unreachable!("read-tree status was already checked"),
                Err(error) => Err(error),
            };
        }
        let output = self
            .run_mutation_with_index(repository.worktree_root(), ["write-tree"], temporary.path())
            .await?
            .require_success()?;
        Ok(MergeTreeResult::Clean(parse_tree(
            output.stdout,
            &output.command,
        )?))
    }

    async fn unmerged_paths(
        &self,
        repository: &GitRepository,
        index: &Path,
    ) -> GitResult<Vec<PathBuf>> {
        let output = self
            .run_mutation_with_index(
                repository.worktree_root(),
                ["ls-files", "--unmerged", "-z"],
                index,
            )
            .await?
            .require_success()?;
        let mut paths = BTreeSet::new();
        for record in output.stdout.split(|byte| *byte == 0) {
            if record.is_empty() {
                continue;
            }
            let Some(separator) = record.iter().position(|byte| *byte == b'\t') else {
                return Err(GitError::invalid_output(
                    output.command,
                    "unmerged index record omitted path",
                ));
            };
            let path = &record[separator + 1..];
            paths.insert(PathBuf::from(String::from_utf8_lossy(path).into_owned()));
        }
        Ok(paths.into_iter().collect())
    }

    async fn create_commit(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
        parent: Option<&str>,
        message: &GitCommitRequest,
    ) -> GitResult<String> {
        let mut arguments = vec!["commit-tree", tree.as_str()];
        if let Some(parent) = parent {
            arguments.extend(["-p", parent]);
        }
        arguments.extend(["-F", "-"]);
        let output = self
            .run_mutation_with_stdin(
                repository.worktree_root(),
                arguments,
                message.message().as_bytes().to_vec(),
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

    async fn update_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        new_value: &str,
        old_value: &str,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference, new_value, old_value],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    async fn update_optional_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        new_value: &str,
        old_value: Option<&str>,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference, new_value, old_value.unwrap_or("")],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    async fn delete_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        old_value: &str,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", "-d", reference, old_value],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    async fn install_checkout_state(
        &self,
        repository: &GitRepository,
        worktree: &GitTreeId,
        index: &GitTreeId,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["read-tree", "--reset", "-u", worktree.as_str()],
        )
        .await?
        .require_success()?;
        self.run_mutation(
            repository.worktree_root(),
            ["read-tree", "--reset", index.as_str()],
        )
        .await?
        .require_success()?;
        Ok(())
    }
}

fn journal_path(repository: &GitRepository, transaction_id: &str) -> GitResult<PathBuf> {
    validate_transaction_id(transaction_id)?;
    Ok(repository
        .common_dir()
        .join("ash")
        .join("commit-transactions")
        .join(format!("{transaction_id}.json")))
}

fn validate_transaction_id(transaction_id: &str) -> GitResult<()> {
    if transaction_id.is_empty()
        || transaction_id.len() > 128
        || !transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(GitError::InvalidConfiguration {
            field: "transaction ID",
            requirement: "must contain only ASCII letters, digits, '-' or '_'",
        });
    }
    Ok(())
}

fn validate_target_branch(target_branch: &str) -> GitResult<()> {
    if target_branch.trim().is_empty()
        || target_branch.starts_with('-')
        || target_branch.contains(char::is_whitespace)
    {
        return Err(GitError::InvalidConfiguration {
            field: "target branch",
            requirement: "must identify one non-empty local branch",
        });
    }
    Ok(())
}

fn target_conflict(actual: Option<&str>, expected: Option<&str>) -> GitTreeCommitConflict {
    if actual.is_none() && expected.is_some() {
        GitTreeCommitConflict::TargetDeleted
    } else {
        GitTreeCommitConflict::TargetMoved
    }
}

fn write_journal(path: &Path, journal: &CommitJournal) -> GitResult<()> {
    let parent = path.parent().ok_or_else(|| {
        GitError::runtime(
            "write commit transaction journal",
            "journal path omitted its parent",
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|source| GitError::io("create commit transaction journal directory", source))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|source| GitError::io("create commit transaction journal", source))?;
    serde_json::to_writer(&mut temporary, journal).map_err(|error| {
        GitError::runtime("encode commit transaction journal", error.to_string())
    })?;
    temporary
        .flush()
        .map_err(|source| GitError::io("flush commit transaction journal", source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| GitError::io("sync commit transaction journal", source))?;
    temporary
        .persist(path)
        .map_err(|error| GitError::io("install commit transaction journal", error.error))?;
    Ok(())
}

fn read_journal(path: &Path) -> GitResult<CommitJournal> {
    let journal = serde_json::from_slice::<CommitJournal>(
        &fs::read(path)
            .map_err(|source| GitError::io("read commit transaction journal", source))?,
    )
    .map_err(|error| GitError::runtime("decode commit transaction journal", error.to_string()))?;
    if !(1..=3).contains(&journal.version) {
        return Err(GitError::runtime(
            "decode commit transaction journal",
            "unsupported journal version",
        ));
    }
    Ok(journal)
}

fn remove_journal(path: &Path) -> GitResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(GitError::io("remove commit transaction journal", source)),
    }
}

fn remove_completed_journal(path: &Path, retain_until_acknowledged: bool) -> GitResult<()> {
    if retain_until_acknowledged {
        Ok(())
    } else {
        remove_journal(path)
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

fn parse_tree(output: Vec<u8>, command: &str) -> GitResult<GitTreeId> {
    let value = String::from_utf8(output)
        .map_err(|_| GitError::invalid_output(command, "tree object ID was not UTF-8"))?;
    GitTreeId::new(value.trim().to_string())
}

fn validate_object_id(value: &str, field: &'static str) -> GitResult<()> {
    if !(40..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::InvalidConfiguration {
            field,
            requirement: "must be a hexadecimal Git object ID",
        });
    }
    Ok(())
}

fn changed_paths(changes: Vec<crate::GitTreeChange>) -> Vec<PathBuf> {
    let mut paths = BTreeSet::new();
    for change in changes {
        if let Some(previous) = change.previous_path() {
            paths.insert(previous.to_path_buf());
        }
        paths.insert(change.path().to_path_buf());
    }
    paths.into_iter().collect()
}

#[cfg(test)]
#[path = "tree_commit_tests.rs"]
mod tests;
