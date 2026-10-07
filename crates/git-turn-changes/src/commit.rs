use crate::CaptureState;
use crate::ChangeSetId;
use crate::CommitState;
use crate::TurnChangeSet;
use crate::TurnChangeStore;
use crate::TurnChangeStoreError;
use ash_git::GitClient;
use ash_git::GitPrivateRef;
use ash_git::GitRepository;
use ash_git::GitTreeId;
use ash_git::GitTreeReplayResult;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use git_transaction::GitPrepareTreeCommitResult;
use git_transaction::GitPreparedTreeCommit;
use git_transaction::GitPreparedTreeCommitRequest;
use git_transaction::GitTransactions;
use git_transaction::GitTreeCommitConflict;
use git_transaction::GitTreeCommitRecovery;
use git_transaction::GitTreeCommitRequest;
use git_transaction::GitTreeCommitResult;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnCommitSelection {
    pub change_set_id: ChangeSetId,
    pub expected_revision: u64,
    pub paths: Vec<PathBuf>,
}

/// Immutable selection evidence, in capture order, independent of later drafts and Turns.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnCommitSource {
    pub change_set_id: ChangeSetId,
    pub expected_revision: u64,
    pub evidence_digest: String,
    pub before_tree: String,
    pub selected_tree: String,
    pub paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum TurnPublication {
    Prepared {
        commit: GitPreparedTreeCommit,
    },
    /// Decoded only by the one-way storage migration. Recovery uses the original transaction ID
    /// before preparing these frozen historical trees; it never reads a mutable Turn draft.
    MigratedDelta {
        before_tree: String,
        after_tree: String,
    },
    Receipt {
        object_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum TurnCommitState {
    Preview,
    Queued,
    Publishing,
    Committed {
        object_id: String,
    },
    Conflict {
        paths: Vec<PathBuf>,
        message: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnCommitRecord {
    pub commit_id: String,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub repository_id: String,
    pub target_branch: String,
    pub sources: Vec<TurnCommitSource>,
    pub message: String,
    /// Frozen review hints from the selected captures; these do not change commit eligibility.
    #[serde(default)]
    pub warnings: Vec<String>,
    pub publication: TurnPublication,
    pub state: TurnCommitState,
    pub revision: u64,
}

/// Persistence owns atomic selection reservations, command receipts, and publication receipts.
/// Updating a commit touches its source Turn revisions in the same transaction. Read operations
/// derive Turn progress from commit records; capture JSON never persists that derived progress.
pub trait TurnCommitStore: TurnChangeStore {
    fn list_commits(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnCommitRecord>, TurnChangeStoreError>;
    fn load_commit(&self, commit_id: &str) -> Result<TurnCommitRecord, TurnChangeStoreError>;
    fn save_preview(
        &self,
        record: &TurnCommitRecord,
        command_id: &str,
        fingerprint: &str,
        response: &str,
    ) -> Result<(), TurnChangeStoreError>;
    fn queue_publication(
        &self,
        commit_id: &str,
        command_id: &str,
        fingerprint: &str,
        response: &str,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError>;
    fn update_publication(
        &self,
        expected_revision: u64,
        record: &TurnCommitRecord,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError>;
}

pub fn commit_transaction_id(command_id: &str) -> String {
    format!("selection-{:x}", Sha256::digest(command_id.as_bytes()))
}

/// Checks Session/Thread ownership and puts selected changes in actual capture order. Tool-read
/// dependencies remain review evidence; immutable delta replay decides whether a selection works.
pub fn validate_selection<'a>(
    records: &'a [TurnChangeSet],
    session_id: &SessionId,
    thread_id: &ThreadId,
    selections: &'a [TurnCommitSelection],
) -> Result<Vec<(&'a TurnChangeSet, &'a [PathBuf])>, String> {
    if selections.is_empty() {
        return Err("selection is empty".into());
    }
    let ids = selections
        .iter()
        .map(|selection| &selection.change_set_id)
        .collect::<BTreeSet<_>>();
    if ids.len() != selections.len() {
        return Err("selection repeats a ChangeSet".into());
    }
    let mut ordered = Vec::new();
    for record in records {
        let Some(selection) = selections
            .iter()
            .find(|selection| selection.change_set_id == record.change_set_id)
        else {
            continue;
        };
        if &record.session_id != session_id || &record.thread_id != thread_id {
            return Err("selection ownership mismatch".into());
        }
        if record.revision != selection.expected_revision {
            return Err("change-set revision conflict".into());
        }
        if record.capture_state != CaptureState::Sealed || record.attribution_incomplete {
            return Err("selection must have complete sealed attribution".into());
        }
        let paths = selection.paths.iter().collect::<BTreeSet<_>>();
        if paths.is_empty() || paths.len() != selection.paths.len() {
            return Err("selection needs distinct changed paths".into());
        }
        if paths.iter().any(|path| {
            !record.files.iter().any(|file| &file.path == *path)
                || record.committed_paths.contains(*path)
        }) {
            return Err("selection contains unknown or committed changes".into());
        }
        ordered.push((record, selection.paths.as_slice()));
    }
    if ordered.len() != selections.len() {
        return Err("selection contains an unknown ChangeSet".into());
    }
    let first = ordered[0].0;
    if ordered.iter().any(|(record, _)| {
        record.repository_id != first.repository_id || record.target_branch != first.target_branch
    }) {
        return Err("a selection must use one repository and target branch".into());
    }
    Ok(ordered)
}

pub async fn prepare_selection(
    git: &GitClient,
    repository: &GitRepository,
    commit_id: String,
    session_id: &SessionId,
    thread_id: &ThreadId,
    records: &[TurnChangeSet],
    selections: &[TurnCommitSelection],
    message: String,
) -> Result<TurnCommitRecord, String> {
    ash_git::GitCommitRequest::new(message.clone()).map_err(|error| error.to_string())?;
    let ordered = validate_selection(records, session_id, thread_id, selections)?;
    let first = ordered.first().ok_or("selection is empty")?.0;
    let branch = first
        .target_branch
        .as_ref()
        .ok_or("detached Thread targets cannot be committed")?;
    let target_head = git
        .read_optional_ref(repository, &format!("refs/heads/{branch}"))
        .await
        .map_err(|error| error.to_string())?;
    if target_head.is_none() && first.base_object_id.is_some() {
        return Err("target branch was deleted".into());
    }
    let target_tree = match target_head.as_deref() {
        Some(head) => git.resolve_tree(repository, head).await,
        None => git.empty_tree(repository).await,
    }
    .map_err(|error| error.to_string())?;
    let mut final_tree = target_tree.clone();
    let mut sources = Vec::new();
    let mut warnings = BTreeSet::new();
    for (record, paths) in ordered {
        warnings.extend(record.warnings.iter().cloned());
        if !record.dependencies.is_empty() || !record.external_dependency_paths.is_empty() {
            warnings.insert("Selected changes read earlier or external edits. Review dependencies and validate the prepared commit.".into());
        }
        let before =
            GitTreeId::new(record.before_tree.clone()).map_err(|error| error.to_string())?;
        let after = GitTreeId::new(
            record
                .after_tree
                .clone()
                .ok_or("sealed Turn has no after tree")?,
        )
        .map_err(|error| error.to_string())?;
        let selected_tree = git
            .select_tree_changes(repository, &before, &after, paths)
            .await
            .map_err(|error| error.to_string())?;
        final_tree = match git
            .replay_tree_delta(repository, &before, &final_tree, &selected_tree)
            .await
            .map_err(|error| error.to_string())?
        {
            GitTreeReplayResult::Clean(tree) => tree,
            GitTreeReplayResult::Conflict { paths } => {
                return Err(format!(
                    "selected changes conflict: {}",
                    paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        };
        sources.push(TurnCommitSource {
            change_set_id: record.change_set_id.clone(),
            expected_revision: record.revision,
            evidence_digest: record
                .evidence_digest()
                .map_err(|error| error.to_string())?
                .to_string(),
            before_tree: before.as_str().into(),
            selected_tree: selected_tree.as_str().into(),
            paths: paths.to_vec(),
        });
    }
    if final_tree == target_tree {
        return Err("selected changes are already present on the target branch".into());
    }
    let request = match target_head {
        Some(head) => GitPreparedTreeCommitRequest::new(
            commit_id.clone(),
            branch.clone(),
            head,
            target_tree,
            final_tree,
            message.clone(),
        ),
        None => GitPreparedTreeCommitRequest::new_unborn(
            commit_id.clone(),
            branch.clone(),
            target_tree,
            final_tree,
            message.clone(),
        ),
    }
    .map_err(|error| error.to_string())?;
    let commit = match GitTransactions::new(git)
        .prepare_tree_commit(repository, &request)
        .await
        .map_err(|error| error.to_string())?
    {
        GitPrepareTreeCommitResult::Prepared(commit) => commit,
        GitPrepareTreeCommitResult::Conflict(conflict) => {
            return Err(format!("target changed during preparation: {conflict:?}"));
        }
    };
    git.pin_private_commit(
        repository,
        &GitPrivateRef::new(format!("refs/ash/turn-commits/{commit_id}/prepared"))
            .map_err(|error| error.to_string())?,
        commit.object_id(),
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(TurnCommitRecord {
        commit_id,
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        repository_id: first.repository_id.clone(),
        target_branch: branch.clone(),
        sources,
        message,
        warnings: warnings.into_iter().collect(),
        publication: TurnPublication::Prepared { commit },
        state: TurnCommitState::Preview,
        revision: 1,
    })
}

/// Publishes a frozen request. A database failure after Git publication leaves Publishing plus
/// the retained journal, so restart recovers the same object instead of creating another commit.
pub async fn publish_selection(
    store: &dyn TurnCommitStore,
    git: &GitClient,
    repository: &GitRepository,
    commit_id: &str,
) -> Result<Vec<TurnChangeSet>, String> {
    let mut record = store
        .load_commit(commit_id)
        .map_err(|error| error.to_string())?;
    if let TurnCommitState::Committed { object_id } = &record.state {
        GitTransactions::new(git)
            .acknowledge_published_tree_commit(repository, commit_id, object_id)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(Vec::new());
    }
    if record.state == TurnCommitState::Queued {
        let expected = record.revision;
        record.revision += 1;
        record.state = TurnCommitState::Publishing;
        store
            .update_publication(expected, &record)
            .map_err(|error| error.to_string())?;
    } else if record.state != TurnCommitState::Publishing {
        return Ok(Vec::new());
    }
    let transaction = GitTransactions::new(git);
    let outcome = match transaction
        .recover_tree_commit(repository, commit_id)
        .await
        .map_err(|error| error.to_string())?
    {
        GitTreeCommitRecovery::Committed { object_id } => {
            GitTreeCommitResult::Committed { object_id }
        }
        GitTreeCommitRecovery::Conflict { paths } => {
            GitTreeCommitResult::Conflict(GitTreeCommitConflict::CheckoutChanged { paths })
        }
        GitTreeCommitRecovery::None | GitTreeCommitRecovery::RolledBack => {
            match &record.publication {
                TurnPublication::Prepared { commit } => transaction
                    .publish_prepared_tree_commit(repository, commit)
                    .await
                    .map_err(|error| error.to_string())?,
                TurnPublication::MigratedDelta {
                    before_tree,
                    after_tree,
                } => {
                    let before =
                        GitTreeId::new(before_tree.clone()).map_err(|error| error.to_string())?;
                    let after =
                        GitTreeId::new(after_tree.clone()).map_err(|error| error.to_string())?;
                    let head = git
                        .read_optional_ref(
                            repository,
                            &format!("refs/heads/{}", record.target_branch),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    let request = match head {
                        Some(head) => GitTreeCommitRequest::new(
                            commit_id.into(),
                            record.target_branch.clone(),
                            head,
                            before,
                            after,
                            record.message.clone(),
                        ),
                        None => GitTreeCommitRequest::new_unborn(
                            commit_id.into(),
                            record.target_branch.clone(),
                            before,
                            after,
                            record.message.clone(),
                        ),
                    }
                    .map_err(|error| error.to_string())?;
                    transaction
                        .commit_tree_delta(repository, &request)
                        .await
                        .map_err(|error| error.to_string())?
                }
                TurnPublication::Receipt { .. } => {
                    return Err("receipt has no pending publication".into());
                }
            }
        }
    };
    let expected = record.revision;
    record.revision += 1;
    record.state = match outcome {
        GitTreeCommitResult::Committed { object_id } => TurnCommitState::Committed { object_id },
        GitTreeCommitResult::Conflict(conflict) => {
            let paths = match &conflict {
                GitTreeCommitConflict::ChangeSet { paths }
                | GitTreeCommitConflict::CheckoutChanged { paths } => paths.clone(),
                GitTreeCommitConflict::TargetMoved
                | GitTreeCommitConflict::TargetDeleted
                | GitTreeCommitConflict::TargetDetached => Vec::new(),
            };
            TurnCommitState::Conflict {
                paths,
                message: match conflict {
                    GitTreeCommitConflict::TargetMoved => {
                        "Target branch changed after preview. Prepare a new preview."
                    }
                    GitTreeCommitConflict::TargetDeleted => "Target branch was deleted.",
                    GitTreeCommitConflict::TargetDetached => "Target checkout is detached.",
                    GitTreeCommitConflict::ChangeSet { .. } => {
                        "Selected file changes conflict with the target branch."
                    }
                    GitTreeCommitConflict::CheckoutChanged { .. } => {
                        "Target checkout changed or its local edits conflict with this commit."
                    }
                }
                .into(),
            }
        }
    };
    let updated = store
        .update_publication(expected, &record)
        .map_err(|error| error.to_string())?;
    if let TurnCommitState::Committed { object_id } = &record.state {
        transaction
            .acknowledge_published_tree_commit(repository, commit_id, object_id)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(updated)
}

pub fn derive_commit_progress(record: &mut TurnChangeSet, commits: &[TurnCommitRecord]) {
    record.committed_paths.clear();
    record.commit_state = CommitState::Idle;
    let mut object_ids = BTreeSet::new();
    // Collect receipts first: an older failed attempt must not hide a later successful retry.
    for commit in commits {
        if let TurnCommitState::Committed { object_id } = &commit.state {
            if let Some(source) = commit
                .sources
                .iter()
                .find(|source| source.change_set_id == record.change_set_id)
            {
                record.committed_paths.extend(source.paths.iter().cloned());
                object_ids.insert(object_id.clone());
            }
        }
    }
    let mut pending = None;
    let mut terminal = None;
    for commit in commits {
        let Some(source) = commit
            .sources
            .iter()
            .find(|source| source.change_set_id == record.change_set_id)
        else {
            continue;
        };
        if source
            .paths
            .iter()
            .all(|path| record.committed_paths.contains(path))
        {
            continue;
        }
        match &commit.state {
            TurnCommitState::Queued => {
                if pending != Some(CommitState::Committing) {
                    pending = Some(CommitState::Queued);
                }
            }
            TurnCommitState::Publishing => pending = Some(CommitState::Committing),
            TurnCommitState::Conflict { paths, message } => {
                terminal = Some(CommitState::Conflict {
                    paths: paths.clone(),
                    message: message.clone(),
                })
            }
            TurnCommitState::Failed { message } => {
                terminal = Some(CommitState::Failed {
                    message: message.clone(),
                })
            }
            TurnCommitState::Preview | TurnCommitState::Committed { .. } => {}
        }
    }
    record.commit_state = if let Some(active) = pending.or(terminal) {
        active
    } else if record.committed_paths.is_empty() {
        CommitState::Idle
    } else if record
        .files
        .iter()
        .all(|file| record.committed_paths.contains(&file.path))
    {
        CommitState::Committed {
            object_id: commits
                .iter()
                .rev()
                .find_map(|commit| match &commit.state {
                    TurnCommitState::Committed { object_id }
                        if commit
                            .sources
                            .iter()
                            .any(|source| source.change_set_id == record.change_set_id) =>
                    {
                        Some(object_id.clone())
                    }
                    _ => None,
                })
                .expect("committed paths have a receipt"),
        }
    } else {
        CommitState::PartiallyCommitted {
            object_ids: object_ids.into_iter().collect(),
        }
    };
}

/// Storage calls this with records read inside its transaction; eligibility belongs to this domain.
pub fn queued_publication(
    record: &TurnCommitRecord,
    captures: &[TurnChangeSet],
    previous: &[TurnCommitRecord],
) -> Result<TurnCommitRecord, TurnChangeStoreError> {
    let invalid = |reason: &str| TurnChangeStoreError::Storage(reason.into());
    if record.state != TurnCommitState::Preview {
        return Err(invalid("commit preview is already submitted"));
    }
    let selections = record
        .sources
        .iter()
        .map(|source| {
            let capture = captures
                .iter()
                .find(|capture| capture.change_set_id == source.change_set_id)
                .ok_or_else(|| invalid("selection capture is missing"))?;
            // Capture revision was checked when preparing the selection. Later draft/message
            // updates must not invalidate the frozen preview; evidence and reservations below
            // are the publication preconditions, read atomically by the store.
            Ok(TurnCommitSelection {
                change_set_id: source.change_set_id.clone(),
                expected_revision: capture.revision,
                paths: source.paths.clone(),
            })
        })
        .collect::<Result<Vec<_>, TurnChangeStoreError>>()?;
    validate_selection(captures, &record.session_id, &record.thread_id, &selections)
        .map_err(TurnChangeStoreError::Storage)?;
    for source in &record.sources {
        let capture = captures
            .iter()
            .find(|capture| capture.change_set_id == source.change_set_id)
            .ok_or_else(|| invalid("selection capture is missing"))?;
        if capture
            .evidence_digest()
            .map_err(|error| invalid(&error.to_string()))?
            .to_string()
            != source.evidence_digest
        {
            return Err(invalid("selection evidence changed"));
        }
        if previous
            .iter()
            .filter(|commit| {
                matches!(
                    commit.state,
                    TurnCommitState::Queued
                        | TurnCommitState::Publishing
                        | TurnCommitState::Committed { .. }
                )
            })
            .any(|commit| {
                commit.sources.iter().any(|reserved| {
                    reserved.change_set_id == source.change_set_id
                        && reserved
                            .paths
                            .iter()
                            .any(|path| source.paths.contains(path))
                })
            })
        {
            return Err(invalid(
                "selected file change is already reserved or committed",
            ));
        }
    }
    let mut queued = record.clone();
    queued.revision = queued
        .revision
        .checked_add(1)
        .ok_or_else(|| invalid("commit revision overflow"))?;
    queued.state = TurnCommitState::Queued;
    Ok(queued)
}

/// Execution updates cannot rewrite the immutable request, selection, owner or publication object.
pub fn validate_publication_update(
    current: &TurnCommitRecord,
    expected: u64,
    next: &TurnCommitRecord,
) -> Result<(), TurnChangeStoreError> {
    if current.revision != expected {
        return Err(TurnChangeStoreError::RevisionConflict {
            expected,
            actual: current.revision,
        });
    }
    let mut execution = current.clone();
    execution.revision = expected
        .checked_add(1)
        .ok_or_else(|| TurnChangeStoreError::Storage("commit revision overflow".into()))?;
    execution.state = next.state.clone();
    if &execution != next
        || !matches!(
            (&current.state, &next.state),
            (TurnCommitState::Queued, TurnCommitState::Publishing)
                | (
                    TurnCommitState::Publishing,
                    TurnCommitState::Committed { .. }
                        | TurnCommitState::Conflict { .. }
                        | TurnCommitState::Failed { .. }
                )
        )
    {
        return Err(TurnChangeStoreError::Storage(
            "invalid publication transition".into(),
        ));
    }
    Ok(())
}

/// Session deletion must not erase the only durable recovery evidence for an in-flight publication.
pub fn require_settled_publications(commits: &[TurnCommitRecord]) -> Result<(), String> {
    if commits.iter().any(|commit| {
        matches!(
            commit.state,
            TurnCommitState::Queued | TurnCommitState::Publishing
        )
    }) {
        Err("Wait for pending Turn commits to finish before deleting this Session.".into())
    } else {
        Ok(())
    }
}
