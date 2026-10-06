use super::AppServer;
use super::RpcError;
use super::decode;
use super::git_turn_changes_runtime::GitTurnChangesRuntime;
use super::git_turn_changes_runtime::summary;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::turn_changes::ChangeSetId as ChangeSetIdDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeFileDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangeFileKindDto;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesCommitParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesDiscardThreadParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesListParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesListResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesPrepareCommitParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesPrepareCommitResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadCommitFileParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadCommitParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadFileParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadFileResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesUpdateDraftParams;
use ash_core::TurnStatus;
use ash_state::TurnChangeCommandOutcome;
use git_turn_changes::ChangeFileKind;
use git_turn_changes::ChangeSetId;
use git_turn_changes::CommitState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeStore;
use git_turn_changes::TurnCommitStore;
use git_turn_changes::TurnPublication;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::sync::Arc;

const MAX_FILE_SIDE_BYTES: usize = 512 * 1024;

impl AppServer {
    pub(super) fn turn_changes_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesListParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let records = runtime
            .list(&params.session_id, &params.thread_id)
            .map_err(operation_error)?;
        result(&TurnChangesListResult {
            dir: runtime.public_binding(&params.thread_id),
            change_sets: records.iter().map(summary).collect(),
        })
    }

    pub(super) fn turn_changes_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesReadParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let record = owned_record(
            &runtime,
            &params.session_id,
            &params.thread_id,
            &params.change_set_id,
        )?;
        result(&TurnChangesReadResult {
            summary: summary(&record),
            files: record.files.iter().map(file_dto).collect(),
            generated_message: record.generated_message,
            draft_message: record.draft_message,
        })
    }

    pub(super) fn turn_changes_read_file(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesReadFileParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let record = owned_record(
            &runtime,
            &params.session_id,
            &params.thread_id,
            &params.change_set_id,
        )?;
        let file = record
            .files
            .iter()
            .find(|file| file.path == Path::new(&params.path))
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let (before, before_truncated, before_binary) =
            read_blob_side(&record, file.before_object_id.as_deref())?;
        let (after, after_truncated, after_binary) =
            read_blob_side(&record, file.after_object_id.as_deref())?;
        let binary = file.binary || before_binary || after_binary;
        result(&TurnChangesReadFileResult {
            path: params.path,
            binary,
            truncated: before_truncated || after_truncated,
            before: (!binary).then_some(before).flatten(),
            after: (!binary).then_some(after).flatten(),
        })
    }

    pub(super) fn turn_changes_generate_message(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesMutationParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let fingerprint = mutation_fingerprint("turnChanges/generateMessage", &params)?;
        if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
            return Ok(response);
        }
        let record = owned_record(
            &runtime,
            &params.session_id,
            &params.thread_id,
            &params.change_set_id,
        )?;
        let record = runtime
            .retry_message(
                record,
                params.expected_revision,
                &params.command_id,
                &fingerprint,
            )
            .map_err(mutation_error)?;
        result(&record)
    }

    pub(super) fn turn_changes_update_draft(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesUpdateDraftParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let fingerprint = mutation_fingerprint("turnChanges/updateDraft", &params)?;
        if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
            return Ok(response);
        }
        let record = owned_record(
            &runtime,
            &params.session_id,
            &params.thread_id,
            &params.change_set_id,
        )?;
        let record = runtime
            .update_draft(
                record,
                params.expected_revision,
                params.message,
                &params.command_id,
                &fingerprint,
            )
            .map_err(mutation_error)?;
        result(&record)
    }

    pub(super) fn turn_changes_prepare_commit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesPrepareCommitParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let fingerprint = mutation_fingerprint("turnChanges/prepareCommit", &params)?;
        if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
            return Ok(response);
        }
        let records = runtime
            .list(&params.session_id, &params.thread_id)
            .map_err(operation_error)?;
        let selections = params
            .selections
            .iter()
            .map(|selection| {
                Ok(git_turn_changes::TurnCommitSelection {
                    change_set_id: ChangeSetId::new(selection.change_set_id.0.clone())
                        .map_err(|error| operation_error(error.to_string()))?,
                    expected_revision: selection.expected_revision,
                    paths: selection
                        .paths
                        .iter()
                        .map(std::path::PathBuf::from)
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        let ordered = git_turn_changes::validate_selection(
            &records,
            &params.session_id,
            &params.thread_id,
            &selections,
        )
        .map_err(mutation_error)?;
        let repository_id = &ordered[0].0.repository_id;
        let binding = runtime
            .binding(&params.thread_id)
            .ok_or_else(|| operation_error("Thread has no directory binding".into()))?;
        let target = binding
            .repositories()
            .iter()
            .find(|repository| repository.repository_id() == repository_id)
            .ok_or_else(|| operation_error("Thread binding omitted repository".into()))?;
        let response = runtime.dirs.runtime.block_on(async {
            let git = ash_git::GitClient::system();
            let repository = git
                .open_repository(target.source_repository_root())
                .await
                .map_err(|error| operation_error(error.to_string()))?;
            let operation = ash_git::repository_operation_lock(&repository);
            let _operation = operation
                .lock()
                .map_err(|_| operation_error("repository operation lock poisoned".into()))?;
            if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
                return Ok(response);
            }
            let commit = git_turn_changes::prepare_selection(
                &git,
                &repository,
                git_turn_changes::commit_transaction_id(params.command_id.as_str()),
                &params.session_id,
                &params.thread_id,
                &records,
                &selections,
                params.message.clone(),
            )
            .await
            .map_err(mutation_error)?;
            let TurnPublication::Prepared { commit: prepared } = &commit.publication else {
                unreachable!("new selection is prepared");
            };
            let files = git
                .diff_trees(&repository, prepared.target_tree(), prepared.final_tree())
                .await
                .map_err(|error| operation_error(error.to_string()))?;
            let preview = TurnChangesPrepareCommitResult {
                commit_id: commit.commit_id.clone(),
                target_branch: commit.target_branch.clone(),
                message: commit.message.clone(),
                files: files
                    .into_iter()
                    .map(git_turn_changes::change_file)
                    .map(|file| file_dto(&file))
                    .collect(),
                warnings: commit.warnings.clone(),
            };
            let response = result(&preview)?;
            runtime
                .store
                .save_preview(
                    &commit,
                    params.command_id.as_str(),
                    &fingerprint,
                    &response.to_string(),
                )
                .map_err(|error| mutation_error(error.to_string()))?;
            Ok::<_, RpcError>(response)
        })?;
        Ok(response)
    }

    pub(super) fn turn_changes_read_commit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesReadCommitParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let commit = runtime
            .store
            .load_commit(&params.commit_id)
            .map_err(|error| operation_error(error.to_string()))?;
        if commit.session_id != params.session_id || commit.thread_id != params.thread_id {
            return Err(operation_error("commit ownership mismatch".into()));
        }
        let capture = runtime
            .store
            .load(&commit.sources[0].change_set_id)
            .map_err(|error| operation_error(error.to_string()))?;
        let TurnPublication::Prepared { commit: prepared } = &commit.publication else {
            return Err(operation_error("commit has no preview".into()));
        };
        runtime.dirs.runtime.block_on(async {
            let git = ash_git::GitClient::system();
            let files = git
                .diff_trees_at_git_dir(
                    &capture.git_common_dir,
                    prepared.target_tree(),
                    prepared.final_tree(),
                )
                .await
                .map_err(|error| operation_error(error.to_string()))?;
            result(&TurnChangesPrepareCommitResult {
                commit_id: commit.commit_id.clone(),
                target_branch: commit.target_branch.clone(),
                message: commit.message.clone(),
                files: files
                    .into_iter()
                    .map(git_turn_changes::change_file)
                    .map(|file| file_dto(&file))
                    .collect(),
                warnings: commit.warnings.clone(),
            })
        })
    }

    pub(super) fn turn_changes_read_commit_file(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesReadCommitFileParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let commit = runtime
            .store
            .load_commit(&params.commit_id)
            .map_err(|error| operation_error(error.to_string()))?;
        if commit.session_id != params.session_id || commit.thread_id != params.thread_id {
            return Err(operation_error("commit ownership mismatch".into()));
        }
        let capture = runtime
            .store
            .load(&commit.sources[0].change_set_id)
            .map_err(|error| operation_error(error.to_string()))?;
        let TurnPublication::Prepared { commit: prepared } = &commit.publication else {
            return Err(operation_error("commit has no preview".into()));
        };
        runtime.dirs.runtime.block_on(async {
            let git = ash_git::GitClient::system();
            let files = git
                .diff_trees_at_git_dir(
                    &capture.git_common_dir,
                    prepared.target_tree(),
                    prepared.final_tree(),
                )
                .await
                .map_err(|error| operation_error(error.to_string()))?;
            let file = files
                .iter()
                .find(|file| file.path() == Path::new(&params.path))
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
            let (before, before_truncated, before_binary) =
                read_repository_blob(&git, &capture.git_common_dir, file.before_object_id())
                    .await?;
            let (after, after_truncated, after_binary) =
                read_repository_blob(&git, &capture.git_common_dir, file.after_object_id()).await?;
            let binary = file.binary() || before_binary || after_binary;
            result(&TurnChangesReadFileResult {
                path: params.path,
                binary,
                truncated: before_truncated || after_truncated,
                before: (!binary).then_some(before).flatten(),
                after: (!binary).then_some(after).flatten(),
            })
        })
    }

    pub(super) fn turn_changes_commit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesCommitParams = decode(params)?;
        let runtime = self.git_turn_changes_runtime()?;
        let fingerprint = mutation_fingerprint("turnChanges/commit", &params)?;
        if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
            return Ok(response);
        }
        let commit = runtime
            .store
            .load_commit(&params.commit_id)
            .map_err(|error| operation_error(error.to_string()))?;
        if commit.session_id != params.session_id || commit.thread_id != params.thread_id {
            return Err(operation_error("commit ownership mismatch".into()));
        }
        let binding = runtime
            .binding(&params.thread_id)
            .ok_or_else(|| operation_error("Thread has no directory binding".into()))?;
        let mut records = commit
            .sources
            .iter()
            .map(|source| {
                runtime
                    .store
                    .load(&source.change_set_id)
                    .map_err(|error| operation_error(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        for record in &mut records {
            record.commit_state = CommitState::Queued;
            record.revision += 1;
        }
        let response = result(&TurnChangesMutationResult {
            change_sets: records.iter().map(summary).collect(),
        })?;
        let updated = runtime
            .store
            .queue_publication(
                &params.commit_id,
                params.command_id.as_str(),
                &fingerprint,
                &response.to_string(),
            )
            .map_err(|error| mutation_error(error.to_string()))?;
        runtime.publish(&updated);
        super::git_turn_changes_commit::spawn_commit_job(
            Arc::clone(&runtime.store),
            Arc::clone(&runtime.updates),
            binding,
            params.commit_id,
        );
        replayed_response(&runtime, &params.command_id, &fingerprint)?
            .ok_or_else(|| operation_error("queued command omitted receipt".into()))
    }

    pub(super) fn turn_changes_discard_thread(&self, params: &Value) -> Result<Value, RpcError> {
        let params: TurnChangesDiscardThreadParams = decode(params)?;
        if !params.confirmed {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let runtime = self.git_turn_changes_runtime()?;
        let fingerprint = mutation_fingerprint("turnChanges/discardThread", &params)?;
        if let Some(response) = replayed_response(&runtime, &params.command_id, &fingerprint)? {
            return Ok(response);
        }
        let thread = self
            .threads
            .read_thread(&params.thread_id)
            .map_err(|_| operation_error("Thread is unavailable".into()))?;
        if thread.session_id != params.session_id
            || thread.turns.iter().any(|turn| {
                matches!(
                    turn.status,
                    TurnStatus::Created
                        | TurnStatus::Running
                        | TurnStatus::WaitingForApproval
                        | TurnStatus::WaitingForUserInput
                        | TurnStatus::WaitingForCapability
                        | TurnStatus::Cancelling
                )
            })
        {
            return Err(operation_error(
                "cannot discard a Thread while one of its Turns is running".into(),
            ));
        }
        let records = runtime
            .list(&params.session_id, &params.thread_id)
            .map_err(operation_error)?;
        let actual_revision = records
            .iter()
            .map(|record| record.revision)
            .max()
            .unwrap_or(0);
        if actual_revision != params.expected_revision {
            return Err(revision_error());
        }
        let mut discarded = Vec::new();
        let mut updates = Vec::new();
        for mut record in records {
            if matches!(record.commit_state, CommitState::Committed { .. }) {
                discarded.push(record);
                continue;
            }
            let expected = record.revision;
            record
                .discard()
                .map_err(|error| operation_error(error.to_string()))?;
            debug_assert_eq!(record.revision, expected + 1);
            updates.push(record.clone());
            discarded.push(record);
        }
        runtime
            .reset_thread_to_committed_changes(&params.thread_id, &discarded)
            .map_err(operation_error)?;
        let response = TurnChangesMutationResult {
            change_sets: discarded.iter().map(summary).collect(),
        };
        let response_json =
            serde_json::to_string(&response).map_err(|error| operation_error(error.to_string()))?;
        match runtime
            .store()
            .apply_command(
                params.command_id.as_str(),
                &fingerprint,
                Some((&params.thread_id, params.expected_revision)),
                &updates,
                &response_json,
            )
            .map_err(|error| mutation_error(error.to_string()))?
        {
            TurnChangeCommandOutcome::Applied => runtime.publish(&discarded),
            TurnChangeCommandOutcome::Replayed(response) => {
                return serde_json::from_str(&response)
                    .map_err(|error| operation_error(error.to_string()));
            }
        }
        result(&response)
    }

    pub(super) fn git_turn_changes_runtime(&self) -> Result<Arc<GitTurnChangesRuntime>, RpcError> {
        self.git_turn_changes
            .as_ref()
            .cloned()
            .ok_or_else(|| RpcError::new(-32080, AppServerErrorName::TurnChangesUnavailable))
    }
}

fn mutation_fingerprint(method: &str, params: &impl serde::Serialize) -> Result<String, RpcError> {
    let mut value =
        serde_json::to_value(params).map_err(|error| operation_error(error.to_string()))?;
    let Value::Object(fields) = &mut value else {
        return Err(operation_error(
            "mutation parameters are not an object".into(),
        ));
    };
    fields.remove("commandId");
    let bytes =
        serde_json::to_vec(&(method, value)).map_err(|error| operation_error(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn replayed_response(
    runtime: &GitTurnChangesRuntime,
    command_id: &ash_protocol::CommandId,
    fingerprint: &str,
) -> Result<Option<Value>, RpcError> {
    runtime
        .store()
        .replay_command(command_id.as_str(), fingerprint)
        .map_err(|error| mutation_error(error.to_string()))?
        .map(|response| {
            serde_json::from_str(&response).map_err(|error| operation_error(error.to_string()))
        })
        .transpose()
}

fn owned_record(
    runtime: &GitTurnChangesRuntime,
    session_id: &ash_protocol::SessionId,
    thread_id: &ash_protocol::ThreadId,
    change_set_id: &ChangeSetIdDto,
) -> Result<TurnChangeSet, RpcError> {
    if runtime
        .binding(thread_id)
        .is_some_and(|binding| binding.kind() == worktree::ManagedDirKind::Directory)
    {
        return Err(operation_error(
            "non-Git Threads do not have Git ChangeSets".into(),
        ));
    }
    let id = ChangeSetId::new(change_set_id.0.clone())
        .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
    let record = runtime
        .store()
        .load(&id)
        .map_err(|error| operation_error(error.to_string()))?;
    if &record.session_id != session_id || &record.thread_id != thread_id {
        return Err(operation_error("ChangeSet ownership mismatch".into()));
    }
    Ok(record)
}

fn file_dto(file: &git_turn_changes::ChangeFile) -> TurnChangeFileDto {
    TurnChangeFileDto {
        path: file.path.to_string_lossy().into_owned(),
        previous_path: file
            .previous_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        kind: match file.kind {
            ChangeFileKind::Added => TurnChangeFileKindDto::Added,
            ChangeFileKind::Modified => TurnChangeFileKindDto::Modified,
            ChangeFileKind::Deleted => TurnChangeFileKindDto::Deleted,
            ChangeFileKind::Renamed => TurnChangeFileKindDto::Renamed,
            ChangeFileKind::TypeChanged => TurnChangeFileKindDto::TypeChanged,
        },
        before_mode: file.before_mode.clone(),
        after_mode: file.after_mode.clone(),
        binary: file.binary,
        additions: file.additions,
        deletions: file.deletions,
    }
}

fn read_blob_side(
    record: &TurnChangeSet,
    object_id: Option<&str>,
) -> Result<(Option<String>, bool, bool), RpcError> {
    let Some(object_id) = object_id else {
        return Ok((None, false, false));
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| operation_error(error.to_string()))?;
    let (bytes, truncated) = runtime
        .block_on(async {
            let git = ash_git::GitClient::system();
            git.read_blob_at_git_dir(&record.git_common_dir, object_id, MAX_FILE_SIDE_BYTES)
                .await
        })
        .map_err(|error| operation_error(error.to_string()))?;
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let text = (!binary).then(|| String::from_utf8(bytes).expect("UTF-8 was checked"));
    Ok((text, truncated, binary))
}

fn mutation_error(error: String) -> RpcError {
    if error.contains("revision conflict") {
        revision_error()
    } else {
        operation_error(error)
    }
}

fn revision_error() -> RpcError {
    RpcError::new(-32081, AppServerErrorName::TurnChangesRevisionConflict)
}

fn operation_error(detail: String) -> RpcError {
    RpcError::with_details(
        -32082,
        AppServerErrorName::TurnChangesOperationFailed,
        detail,
    )
}

async fn read_repository_blob(
    git: &ash_git::GitClient,
    git_directory: &std::path::Path,
    object_id: Option<&str>,
) -> Result<(Option<String>, bool, bool), RpcError> {
    let Some(object_id) = object_id else {
        return Ok((None, false, false));
    };
    let (bytes, truncated) = git
        .read_blob_at_git_dir(git_directory, object_id, MAX_FILE_SIDE_BYTES)
        .await
        .map_err(|error| operation_error(error.to_string()))?;
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    Ok((
        (!binary).then(|| String::from_utf8(bytes).expect("UTF-8 checked")),
        truncated,
        binary,
    ))
}
