//! Conditional Git commit publication and durable checkout recovery.

use ash_git::GitClient;
use ash_git::GitCommitRequest;
use ash_git::GitError;
use ash_git::GitHead;
use ash_git::GitPrivateRef;
use ash_git::GitRepository;
use ash_git::GitResult;
use ash_git::GitTreeId;
use ash_git::GitTreeReplayResult;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

/// Immutable Turn delta and the target branch revision observed when commit work starts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeCommitRequest {
    transaction_id: String,
    target_branch: String,
    expected_target_head: Option<String>,
    before_tree: GitTreeId,
    after_tree: GitTreeId,
    message: GitCommitRequest,
    created_at: u64,
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
    created_at: u64,
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
            created_at: preparation_time()?,
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
            created_at: preparation_time()?,
        })
    }

    pub fn target_branch(&self) -> &str {
        &self.target_branch
    }
}

/// Commit object built from a sealed tree for later conditional publication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitPreparedTreeCommit {
    transaction_id: String,
    target_branch: String,
    expected_target_head: Option<String>,
    target_tree: GitTreeId,
    final_tree: GitTreeId,
    object_id: String,
}

impl GitPreparedTreeCommit {
    pub fn target_tree(&self) -> &GitTreeId {
        &self.target_tree
    }
    pub fn final_tree(&self) -> &GitTreeId {
        &self.final_tree
    }
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
            created_at: preparation_time()?,
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
    #[serde(default)]
    checkout_installed: bool,
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

/// One executor shared with the caller; publication rules and journals are owned here.
pub struct GitTransactions<'a> {
    git: &'a GitClient,
}

impl<'a> GitTransactions<'a> {
    pub fn new(git: &'a GitClient) -> Self {
        Self { git }
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
        if journal.checkout_installed {
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        }
        let current = self
            .git
            .read_optional_ref(repository, &journal.target_ref)
            .await?;
        if current == journal.old_head {
            self.release_journal(repository, transaction_id, &path)
                .await?;
            return Ok(GitTreeCommitRecovery::RolledBack);
        }
        if current.as_deref() != Some(journal.new_head.as_str()) {
            return Ok(GitTreeCommitRecovery::Conflict { paths: Vec::new() });
        }
        let Some(checkout) = journal.checkout.as_ref() else {
            complete_recovered_journal(&path, &journal)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        };
        let checkout_repository = self.git.open_repository(&checkout.root).await?;
        let current_index = self.git.capture_index_tree(&checkout_repository).await?;
        let current_worktree = self.git.capture_worktree_tree(&checkout_repository).await?;
        let desired_index = GitTreeId::new(checkout.desired_index.clone())?;
        let desired_worktree = GitTreeId::new(checkout.desired_worktree.clone())?;
        let original_index = GitTreeId::new(checkout.original_index.clone())?;
        let original_worktree = GitTreeId::new(checkout.original_worktree.clone())?;
        if current_index == desired_index && current_worktree == desired_worktree {
            complete_recovered_journal(&path, &journal)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        }
        let install_can_resume = (current_index == original_index
            && current_worktree == original_worktree)
            || (current_index == desired_worktree && current_worktree == desired_worktree);
        if install_can_resume {
            self.git
                .install_checkout_state(&checkout_repository, &desired_worktree, &desired_index)
                .await?;
            complete_recovered_journal(&path, &journal)?;
            return Ok(GitTreeCommitRecovery::Committed {
                object_id: journal.new_head,
            });
        }
        let paths = changed_paths(
            self.git
                .diff_trees(&checkout_repository, &original_worktree, &current_worktree)
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
        self.release_journal(repository, transaction_id, &path)
            .await
    }

    pub async fn prepare_tree_commit(
        &self,
        repository: &GitRepository,
        request: &GitPreparedTreeCommitRequest,
    ) -> GitResult<GitPrepareTreeCommitResult> {
        self.git
            .validate_branch_name(repository, request.target_branch())
            .await?;
        let target_ref = format!("refs/heads/{}", request.target_branch);
        let target_head = self.git.read_optional_ref(repository, &target_ref).await?;
        if target_head != request.expected_target_head {
            return Ok(GitPrepareTreeCommitResult::Conflict(target_conflict(
                target_head.as_deref(),
                request.expected_target_head.as_deref(),
            )));
        }
        let target_tree = match target_head.as_deref() {
            Some(target_head) => self.git.resolve_tree(repository, target_head).await?,
            None => self.git.empty_tree(repository).await?,
        };
        if target_tree != request.target_tree {
            return Ok(GitPrepareTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }
        let object_id = self
            .git
            .create_commit_object(
                repository,
                &request.final_tree,
                target_head.as_deref(),
                &request.message,
                request.created_at,
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
        self.git
            .validate_branch_name(repository, prepared.target_branch())
            .await?;
        let target_ref = format!("refs/heads/{}", prepared.target_branch);
        let target_head = self.git.read_optional_ref(repository, &target_ref).await?;
        if target_head != prepared.expected_target_head {
            return Ok(GitTreeCommitResult::Conflict(target_conflict(
                target_head.as_deref(),
                prepared.expected_target_head.as_deref(),
            )));
        }
        let target_tree = match target_head.as_deref() {
            Some(target_head) => self.git.resolve_tree(repository, target_head).await?,
            None => self.git.empty_tree(repository).await?,
        };
        if target_tree != prepared.target_tree
            || self
                .git
                .resolve_tree(repository, &prepared.object_id)
                .await?
                != prepared.final_tree
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
                    .git
                    .replay_tree_delta(
                        &state.repository,
                        &prepared.target_tree,
                        &prepared.final_tree,
                        &state.index_tree,
                    )
                    .await?
                {
                    GitTreeReplayResult::Clean(tree) => tree,
                    GitTreeReplayResult::Conflict { paths } => {
                        return Ok(GitTreeCommitResult::Conflict(
                            GitTreeCommitConflict::CheckoutChanged { paths },
                        ));
                    }
                };
                let worktree_tree = match self
                    .git
                    .replay_tree_delta(
                        &state.repository,
                        &state.index_tree,
                        &index_tree,
                        &state.worktree_tree,
                    )
                    .await?
                {
                    GitTreeReplayResult::Clean(tree) => tree,
                    GitTreeReplayResult::Conflict { paths } => {
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
            let snapshot = self.git.snapshot(&state.repository).await?;
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
            let latest_index = self.git.capture_index_tree(&state.repository).await?;
            let latest_worktree = self.git.capture_worktree_tree(&state.repository).await?;
            if latest_index != state.index_tree || latest_worktree != state.worktree_tree {
                let paths = changed_paths(
                    self.git
                        .diff_trees(&state.repository, &state.worktree_tree, &latest_worktree)
                        .await?,
                );
                return Ok(GitTreeCommitResult::Conflict(
                    GitTreeCommitConflict::CheckoutChanged { paths },
                ));
            }
        }
        let latest_head = self.git.read_optional_ref(repository, &target_ref).await?;
        if latest_head != target_head {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetMoved,
            ));
        }

        let journal_path = journal_path(repository, &prepared.transaction_id)?;
        let journal = CommitJournal {
            version: 4,
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
            checkout_installed: false,
        };
        // The journal is recovery evidence, but only refs keep its checkout trees alive during GC.
        self.retain_journal_objects(repository, &prepared.transaction_id, &journal)
            .await?;
        write_journal(&journal_path, &journal)?;

        if let Err(error) = self
            .git
            .update_optional_ref_cas(
                repository,
                &target_ref,
                &prepared.object_id,
                target_head.as_deref(),
            )
            .await
        {
            let actual = self.git.read_optional_ref(repository, &target_ref).await?;
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
                self.release_journal(repository, &prepared.transaction_id, &journal_path)
                    .await?;
                return Ok(GitTreeCommitResult::Conflict(target_conflict(
                    actual.as_deref(),
                    target_head.as_deref(),
                )));
            }
            return Err(error);
        }
        if let (Some(state), Some((index_tree, worktree_tree))) = (checkout, checkout_update)
            && let Err(error) = self
                .git
                .install_checkout_state(&state.repository, &worktree_tree, &index_tree)
                .await
        {
            let rollback = match target_head.as_deref() {
                Some(target_head) => {
                    self.git
                        .update_ref_cas(repository, &target_ref, target_head, &prepared.object_id)
                        .await
                }
                None => {
                    self.git
                        .delete_ref_cas(repository, &target_ref, &prepared.object_id)
                        .await
                }
            };
            let restore = self
                .git
                .install_checkout_state(&state.repository, &state.worktree_tree, &state.index_tree)
                .await;
            if rollback.is_err() || restore.is_err() {
                return Err(GitError::runtime(
                    "restore prepared tree commit transaction",
                    format!("install failed: {error}; repository requires transaction recovery"),
                ));
            }
            self.release_journal(repository, &prepared.transaction_id, &journal_path)
                .await?;
            return Err(error);
        }
        let mut completed = journal;
        completed.checkout_installed = true;
        write_journal(&journal_path, &completed)?;
        Ok(GitTreeCommitResult::Committed {
            object_id: prepared.object_id.clone(),
        })
    }

    async fn retain_journal_objects(
        &self,
        repository: &GitRepository,
        id: &str,
        journal: &CommitJournal,
    ) -> GitResult<()> {
        self.git
            .pin_private_commit(repository, &journal_ref(id, "commit")?, &journal.new_head)
            .await?;
        if let Some(checkout) = &journal.checkout {
            for (name, tree) in [
                ("original-index", &checkout.original_index),
                ("original-worktree", &checkout.original_worktree),
                ("desired-index", &checkout.desired_index),
                ("desired-worktree", &checkout.desired_worktree),
            ] {
                self.git
                    .pin_private_ref(
                        repository,
                        &journal_ref(id, name)?,
                        &GitTreeId::new(tree.clone())?,
                    )
                    .await?;
            }
        }
        Ok(())
    }

    async fn release_journal(
        &self,
        repository: &GitRepository,
        id: &str,
        path: &Path,
    ) -> GitResult<()> {
        // Remove refs first: interruption leaves the journal available for another acknowledgement.
        for name in [
            "commit",
            "original-index",
            "original-worktree",
            "desired-index",
            "desired-worktree",
        ] {
            self.git
                .delete_private_ref(repository, &journal_ref(id, name)?)
                .await?;
        }
        remove_journal(path)
    }

    async fn target_checkout(
        &self,
        repository: &GitRepository,
        branch: &str,
    ) -> GitResult<Option<CheckoutState>> {
        for worktree in self.git.worktrees(repository).await? {
            if worktree.branch() != Some(branch) {
                continue;
            }
            if !worktree.availability().is_available() {
                let tree = if worktree.head().bytes().all(|byte| byte == b'0') {
                    self.git.empty_tree(repository).await?
                } else {
                    self.git.resolve_tree(repository, worktree.head()).await?
                };
                return Ok(Some(CheckoutState {
                    repository: self.git.open_repository(worktree.checkout_root()).await?,
                    index_tree: tree.clone(),
                    worktree_tree: tree,
                }));
            }
            let checkout = self.git.open_repository(worktree.checkout_root()).await?;
            let snapshot = self.git.snapshot(&checkout).await?;
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
                index_tree: self.git.capture_index_tree(&checkout).await?,
                worktree_tree: self.git.capture_worktree_tree(&checkout).await?,
                repository: checkout,
            }));
        }
        Ok(None)
    }

    /// Prepares and publishes a delta. The caller must persist its receipt before acknowledging.
    pub async fn commit_tree_delta(
        &self,
        repository: &GitRepository,
        request: &GitTreeCommitRequest,
    ) -> GitResult<GitTreeCommitResult> {
        if matches!(
            self.git.snapshot(repository).await?.head(),
            GitHead::Detached { .. }
        ) {
            return Ok(GitTreeCommitResult::Conflict(
                GitTreeCommitConflict::TargetDetached,
            ));
        }
        let target_head = self
            .git
            .read_optional_ref(repository, &format!("refs/heads/{}", request.target_branch))
            .await?;
        if target_head != request.expected_target_head {
            return Ok(GitTreeCommitResult::Conflict(target_conflict(
                target_head.as_deref(),
                request.expected_target_head.as_deref(),
            )));
        }
        let target_tree = match target_head.as_deref() {
            Some(head) => self.git.resolve_tree(repository, head).await?,
            None => self.git.empty_tree(repository).await?,
        };
        let final_tree = match self
            .git
            .replay_tree_delta(
                repository,
                &request.before_tree,
                &target_tree,
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
        let prepared = self
            .prepare_tree_commit(
                repository,
                &GitPreparedTreeCommitRequest {
                    transaction_id: request.transaction_id.clone(),
                    target_branch: request.target_branch.clone(),
                    expected_target_head: target_head,
                    target_tree,
                    final_tree,
                    message: request.message.clone(),
                    created_at: request.created_at,
                },
            )
            .await?;
        match prepared {
            GitPrepareTreeCommitResult::Prepared(prepared) => {
                self.publish_prepared_tree_commit(repository, &prepared)
                    .await
            }
            GitPrepareTreeCommitResult::Conflict(conflict) => {
                Ok(GitTreeCommitResult::Conflict(conflict))
            }
        }
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
    if !(1..=4).contains(&journal.version) {
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

fn complete_recovered_journal(path: &Path, journal: &CommitJournal) -> GitResult<()> {
    if journal.retain_until_acknowledged {
        let mut completed = journal.clone();
        completed.checkout_installed = true;
        write_journal(path, &completed)
    } else {
        remove_journal(path)
    }
}

fn validate_object_id(value: &str, field: &'static str) -> GitResult<()> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::InvalidConfiguration {
            field,
            requirement: "must be a hexadecimal Git object ID",
        });
    }
    Ok(())
}

fn changed_paths(changes: Vec<ash_git::GitTreeChange>) -> Vec<PathBuf> {
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
#[path = "transaction_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../git/src/test_support.rs"]
pub mod test_support;

fn preparation_time() -> GitResult<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| GitError::runtime("capture commit preparation time", error.to_string()))
}

fn journal_ref(id: &str, name: &str) -> GitResult<GitPrivateRef> {
    GitPrivateRef::new(format!("refs/ash/commit-transactions/{id}/{name}"))
}
