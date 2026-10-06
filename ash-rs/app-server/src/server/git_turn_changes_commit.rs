use super::git_turn_changes_runtime::publish_records;
use super::update_broker::UpdateBroker;
use ash_state::SqliteTurnChangeStore;
use git_turn_changes::TurnCommitStore;
use std::sync::Arc;
use worktree::ManagedDirBinding;

/// Host scheduling and domain assembly only. Selection, publication, and recovery live in the
/// Turn change domain; the directory owner supplies the target repository path.
pub(super) fn spawn_commit_job(
    store: Arc<SqliteTurnChangeStore>,
    updates: Arc<UpdateBroker>,
    binding: ManagedDirBinding,
    commit_id: String,
) {
    let _ = std::thread::Builder::new()
        .name("ash-turn-commit".into())
        .spawn(move || {
            let outcome = (|| {
                let commit = store
                    .load_commit(&commit_id)
                    .map_err(|error| error.to_string())?;
                let target = binding
                    .repositories()
                    .iter()
                    .find(|repository| repository.repository_id() == commit.repository_id)
                    .ok_or("Thread binding omitted commit repository")?;
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?;
                runtime.block_on(async {
                    let git = ash_git::GitClient::system();
                    let repository = git
                        .open_repository(target.source_repository_root())
                        .await
                        .map_err(|error| error.to_string())?;
                    let operation = ash_git::repository_operation_lock(&repository);
                    let _operation = operation
                        .lock()
                        .map_err(|_| "repository operation lock poisoned")?;
                    git_turn_changes::publish_selection(
                        store.as_ref(),
                        &git,
                        &repository,
                        &commit_id,
                    )
                    .await
                })
            })();
            match outcome {
                Ok(records) => publish_records(&updates, &records),
                Err(error) => log::error!("Turn commit {commit_id} requires recovery: {error}"),
            }
        });
}
