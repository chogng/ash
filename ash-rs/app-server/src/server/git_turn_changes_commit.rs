use super::git_turn_changes_runtime::publish_records;
use super::update_broker::UpdateBroker;
use ash_state::SqliteTurnChangeStore;
use git_turn_changes::{CommitState, TurnChangeSet, TurnChangeStore};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use worktree::ManagedDirBinding;

pub(super) fn spawn_commit_job(
    store: Arc<SqliteTurnChangeStore>,
    updates: Arc<UpdateBroker>,
    binding: ManagedDirBinding,
    change_set_id: git_turn_changes::ChangeSetId,
) {
    let _ = std::thread::Builder::new()
        .name("ash-change-set-commit".into())
        .spawn(move || {
            if let Err(error) = commit_change_set(&store, &updates, &binding, &change_set_id) {
                log::error!("ChangeSet commit failed: {error}");
            }
        });
}

fn commit_change_set(
    store: &SqliteTurnChangeStore,
    updates: &UpdateBroker,
    binding: &ManagedDirBinding,
    change_set_id: &git_turn_changes::ChangeSetId,
) -> Result<(), String> {
    let mut record = store
        .load(change_set_id)
        .map_err(|error| error.to_string())?;
    if record.commit_state == CommitState::Queued {
        let expected = record.revision;
        record.begin_commit().map_err(|error| error.to_string())?;
        store
            .compare_and_swap(expected, &record)
            .map_err(|error| error.to_string())?;
        publish_records(updates, &[record.clone()]);
    } else if record.commit_state != CommitState::Committing {
        return Ok(());
    }

    let outcome = (|| {
        let transaction_id = commit_transaction_id(change_set_id);
        let repository_binding = binding
            .repositories()
            .iter()
            .find(|repository| repository.repository_id() == record.repository_id)
            .ok_or_else(|| format!("Thread binding omitted repository {}", record.repository_id))?;
        let branch_name = record
            .target_branch
            .as_deref()
            .ok_or_else(|| "detached Thread targets cannot be committed".to_string())?;
        let after_tree = record
            .after_tree
            .as_ref()
            .ok_or_else(|| "sealed ChangeSet omitted its after tree".to_string())?;
        let message = record
            .draft_message()
            .map_err(|error| error.to_string())?
            .to_string();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(async {
            let git = ash_git::GitClient::system();
            let repository = git
                .open_repository(repository_binding.source_repository_root())
                .await
                .map_err(|error| error.to_string())?;
            let operation = ash_git::repository_operation_lock(&repository);
            let _operation = operation
                .lock()
                .map_err(|_| "repository operation lock is poisoned".to_string())?;
            match git
                .recover_tree_commit(&repository, &transaction_id)
                .await
                .map_err(|error| error.to_string())?
            {
                ash_git::GitTreeCommitRecovery::Committed { object_id } => {
                    return Ok(ash_git::GitTreeCommitResult::Committed { object_id });
                }
                ash_git::GitTreeCommitRecovery::Conflict { paths } => {
                    return Ok(ash_git::GitTreeCommitResult::Conflict(
                        ash_git::GitTreeCommitConflict::CheckoutChanged { paths },
                    ));
                }
                ash_git::GitTreeCommitRecovery::None
                | ash_git::GitTreeCommitRecovery::RolledBack => {}
            }
            let branch = git
                .local_branches(&repository)
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|branch| branch.name() == branch_name);
            let before_tree = ash_git::GitTreeId::new(record.before_tree.clone())
                .map_err(|error| error.to_string())?;
            let after_tree =
                ash_git::GitTreeId::new(after_tree.clone()).map_err(|error| error.to_string())?;
            let request = match branch {
                Some(branch) => ash_git::GitTreeCommitRequest::new(
                    transaction_id.clone(),
                    branch_name.to_string(),
                    branch.object_id().to_string(),
                    before_tree,
                    after_tree,
                    message,
                ),
                None if repository_binding.target_unborn() => {
                    ash_git::GitTreeCommitRequest::new_unborn(
                        transaction_id,
                        branch_name.to_string(),
                        before_tree,
                        after_tree,
                        message,
                    )
                }
                None => return Err(format!("target branch {branch_name} was deleted")),
            }
            .map_err(|error| error.to_string())?;
            git.commit_tree_delta(&repository, &request)
                .await
                .map_err(|error| error.to_string())
        })
    })();

    let mut latest = store
        .load(change_set_id)
        .map_err(|error| error.to_string())?;
    let expected = latest.revision;
    match outcome {
        Ok(ash_git::GitTreeCommitResult::Committed { object_id }) => latest
            .finish_commit(object_id)
            .map_err(|error| error.to_string())?,
        Ok(ash_git::GitTreeCommitResult::Conflict(conflict)) => {
            let (paths, message) = commit_conflict(conflict);
            latest
                .fail_commit(paths, message)
                .map_err(|error| error.to_string())?;
        }
        Err(error) => latest
            .fail_commit(Vec::new(), error)
            .map_err(|error| error.to_string())?,
    }
    store
        .compare_and_swap(expected, &latest)
        .map_err(|error| error.to_string())?;
    let mut published = vec![latest.clone()];
    if matches!(latest.commit_state, CommitState::Committed { .. }) {
        published.extend(settle_dependencies(store, &latest)?);
    }
    publish_records(updates, &published);
    Ok(())
}

fn commit_transaction_id(change_set_id: &git_turn_changes::ChangeSetId) -> String {
    format!("changeset-{:x}", Sha256::digest(change_set_id.as_str()))
}

fn commit_conflict(conflict: ash_git::GitTreeCommitConflict) -> (Vec<PathBuf>, String) {
    match conflict {
        ash_git::GitTreeCommitConflict::ChangeSet { paths } => (
            paths,
            "ChangeSet does not replay cleanly onto target branch".into(),
        ),
        ash_git::GitTreeCommitConflict::CheckoutChanged { paths } => (
            paths,
            "target checkout changed during commit preparation".into(),
        ),
        ash_git::GitTreeCommitConflict::TargetMoved => (
            Vec::new(),
            "target branch moved during commit preparation".into(),
        ),
        ash_git::GitTreeCommitConflict::TargetDeleted => {
            (Vec::new(), "target branch was deleted".into())
        }
        ash_git::GitTreeCommitConflict::TargetDetached => {
            (Vec::new(), "target checkout became detached".into())
        }
    }
}

pub(super) fn settle_dependencies(
    store: &SqliteTurnChangeStore,
    committed: &TurnChangeSet,
) -> Result<Vec<TurnChangeSet>, String> {
    let mut settled = Vec::new();
    for mut record in store
        .list_for_thread(&committed.thread_id)
        .map_err(|error| error.to_string())?
    {
        if !record.dependencies.contains(&committed.change_set_id) {
            continue;
        }
        let expected = record.revision;
        record
            .satisfy_dependency(&committed.change_set_id)
            .map_err(|error| error.to_string())?;
        store
            .compare_and_swap(expected, &record)
            .map_err(|error| error.to_string())?;
        settled.push(record);
    }
    Ok(settled)
}
