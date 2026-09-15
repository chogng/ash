use super::git_turn_changes_runtime::publish_records;
use super::update_broker::UpdateBroker;
use ash_config::ConfigStore;
use ash_core::ThreadController;
use ash_file_access::DirId;
use ash_state::SqliteTurnChangeStore;
use core_api::ModelSelection;
use core_api::ModelService;
use git_turn_changes::{MessageState, TurnChangeSet, TurnChangeStore};
use std::sync::Arc;

pub(super) fn spawn_message_job(
    store: Arc<SqliteTurnChangeStore>,
    threads: Arc<ThreadController>,
    model: Arc<dyn ModelService>,
    config: Arc<ConfigStore>,
    dir_id: DirId,
    updates: Arc<UpdateBroker>,
    change_set_id: git_turn_changes::ChangeSetId,
) {
    let _ = std::thread::Builder::new()
        .name("ash-commit-message".into())
        .spawn(move || {
            if let Err(error) = generate_message(
                &store,
                &threads,
                model.as_ref(),
                &config,
                &dir_id,
                &updates,
                &change_set_id,
            ) {
                if let Err(state_error) =
                    fail_pending_message(&store, &updates, &change_set_id, error.clone())
                {
                    log::warn!("failed to record commit-message failure: {state_error}");
                }
                log::warn!("commit-message generation failed: {error}");
            }
        });
}

fn fail_pending_message(
    store: &SqliteTurnChangeStore,
    updates: &UpdateBroker,
    change_set_id: &git_turn_changes::ChangeSetId,
    error: String,
) -> Result<(), String> {
    let mut record = store
        .load(change_set_id)
        .map_err(|store_error| store_error.to_string())?;
    if !matches!(
        record.message_state,
        MessageState::Queued | MessageState::Generating
    ) {
        return Ok(());
    }
    let expected = record.revision;
    record
        .fail_message_generation(error)
        .map_err(|state_error| state_error.to_string())?;
    store
        .compare_and_swap(expected, &record)
        .map_err(|store_error| store_error.to_string())?;
    publish_records(updates, &[record]);
    Ok(())
}

fn generate_message(
    store: &SqliteTurnChangeStore,
    threads: &ThreadController,
    model: &dyn ModelService,
    config: &ConfigStore,
    dir_id: &DirId,
    updates: &UpdateBroker,
    change_set_id: &git_turn_changes::ChangeSetId,
) -> Result<(), String> {
    let snapshot = config.read_snapshot().map_err(|error| error.0)?;
    let selected_model = snapshot
        .values
        .commit_messages
        .authorized_model(
            dir_id,
            snapshot.values.commit_message_model.as_ref(),
            &snapshot.values.providers,
        )
        .cloned()
        .ok_or_else(|| "commit-message model is not authorized for this Directory".to_string())?;
    let mut record = store
        .load(change_set_id)
        .map_err(|error| error.to_string())?;
    if record.message_state == MessageState::Queued {
        let expected = record.revision;
        record
            .begin_message_generation()
            .map_err(|error| error.to_string())?;
        store
            .compare_and_swap(expected, &record)
            .map_err(|error| error.to_string())?;
        publish_records(updates, &[record.clone()]);
    } else if record.message_state != MessageState::Generating {
        return Ok(());
    }

    let outcome = (|| {
        let prompt = commit_message_prompt(threads, &record)?;
        let request = ash_protocol::ModelRequest {
            instructions: Some(
                "Write a Git commit message for exactly the supplied Turn. Output only a Conventional Commit subject and, only when useful, a blank line followed by a concise body. Do not mention later work, hidden reasoning, Thread IDs, or trailers."
                    .into(),
            ),
            input: vec![ash_protocol::InputItem::Message(ash_protocol::Message::text(
                ash_protocol::MessageRole::User,
                prompt,
            ))],
            tools: Vec::new(),
            tool_choice: ash_protocol::ToolChoice::None,
            parallel_tool_calls: false,
            reasoning: None,
            max_output_tokens: Some(512),
            temperature: Some(0.2),
            prompt_cache_key: None,
            prompt_cache_prefix_end: None,
        };
        let cancellation_source = ash_async_utils::CancellationSource::new();
        let cancellation = cancellation_source.token();
        let response = model
            .invoke(
                ModelSelection::Session(&selected_model),
                &request,
                &cancellation,
            )
            .map_err(|error| error.to_string())?;
        let message = response.text().trim().to_string();
        if message.is_empty() {
            return Err("commit-message model returned no text".into());
        }
        Ok(message)
    })();

    let mut latest = store
        .load(change_set_id)
        .map_err(|error| error.to_string())?;
    let expected = latest.revision;
    match outcome {
        Ok(message) => latest
            .finish_message_generation(message)
            .map_err(|error| error.to_string())?,
        Err(error) => latest
            .fail_message_generation(error)
            .map_err(|error| error.to_string())?,
    }
    store
        .compare_and_swap(expected, &latest)
        .map_err(|error| error.to_string())?;
    publish_records(updates, &[latest]);
    Ok(())
}

fn commit_message_prompt(
    threads: &ThreadController,
    record: &TurnChangeSet,
) -> Result<String, String> {
    const MAX_TOOL_RESULT_CHARS: usize = 2_000;
    const MAX_DIFF_BYTES: usize = 512 * 1024;
    let updates = threads
        .thread_updates_after(&record.thread_id, 0)
        .map_err(|error| error.to_string())?;
    let mut context = Vec::new();
    let mut goal = None;
    let mut reached_target = false;
    for update in updates {
        let ash_protocol::ThreadUpdate::Committed { event } = update.update else {
            continue;
        };
        match event {
            ash_protocol::ThreadEvent::GoalCreated { goal: next, .. }
            | ash_protocol::ThreadEvent::GoalUpdated { goal: next, .. } => goal = Some(next),
            ash_protocol::ThreadEvent::GoalCleared { .. } => goal = None,
            ash_protocol::ThreadEvent::ItemCompleted { item, .. } => match item {
                ash_protocol::ThreadItem::UserMessage { text, .. } => {
                    context.push(format!("User: {}", redact_sensitive_text(&text)));
                }
                ash_protocol::ThreadItem::UserContext { name, content, .. } => {
                    context.push(format!(
                        "User context ({name}): {}",
                        redact_sensitive_text(&content)
                    ));
                }
                ash_protocol::ThreadItem::UserAudioAttachment { attachment, .. } => {
                    context.push(format!(
                        "User attached audio ({} ms).",
                        attachment.duration_ms
                    ));
                }
                ash_protocol::ThreadItem::UserImage { .. }
                | ash_protocol::ThreadItem::UserImageAttachment { .. } => {
                    context.push("User attached an image.".into());
                }
                ash_protocol::ThreadItem::AgentMessage { text, .. } => {
                    context.push(format!("Agent: {}", redact_sensitive_text(&text)));
                }
                ash_protocol::ThreadItem::Plan { text, .. } => {
                    context.push(format!("Plan: {}", redact_sensitive_text(&text)));
                }
                ash_protocol::ThreadItem::ToolCall { name, .. } => {
                    context.push(format!("Tool called: {name}"));
                }
                ash_protocol::ThreadItem::ToolResult { text, is_error, .. } => {
                    context.push(format!(
                        "Tool result ({}): {}",
                        if is_error { "error" } else { "success" },
                        redact_sensitive_text(&truncate_chars(&text, MAX_TOOL_RESULT_CHARS))
                    ));
                }
                ash_protocol::ThreadItem::Reasoning { .. } => {}
            },
            ash_protocol::ThreadEvent::PlanUpdated { turn_id, plan, .. }
                if turn_id == record.turn_id =>
            {
                context.push(format!(
                    "Target Turn plan: {}",
                    serde_json::to_string(&plan).map_err(|error| error.to_string())?
                ));
            }
            ash_protocol::ThreadEvent::TurnCompleted { turn_id, .. }
            | ash_protocol::ThreadEvent::TurnFailed { turn_id, .. }
            | ash_protocol::ThreadEvent::TurnInterrupted { turn_id, .. }
                if turn_id == record.turn_id =>
            {
                reached_target = true;
                break;
            }
            _ => {}
        }
    }
    if !reached_target {
        return Err("target Turn terminal boundary is unavailable".into());
    }
    let after_tree = record
        .after_tree
        .as_ref()
        .ok_or_else(|| "sealed ChangeSet omitted its after tree".to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let diff = runtime.block_on(async {
        let git = ash_git::GitClient::system();
        let repository = git
            .open_repository(&record.worktree_root)
            .await
            .map_err(|error| error.to_string())?;
        git.diff_tree_text(
            &repository,
            &ash_git::GitTreeId::new(record.before_tree.clone())
                .map_err(|error| error.to_string())?,
            &ash_git::GitTreeId::new(after_tree.clone()).map_err(|error| error.to_string())?,
            MAX_DIFF_BYTES,
        )
        .await
        .map_err(|error| error.to_string())
    })?;
    let (diff_text, diff_truncated) = (diff.text().to_string(), diff.truncated());
    let goal = goal
        .map(|goal| serde_json::to_string(&goal).map_err(|error| error.to_string()))
        .transpose()?
        .map(|goal| redact_sensitive_text(&goal))
        .unwrap_or_else(|| "none".into());
    let diff_text = redact_sensitive_text(&diff_text);
    Ok(format!(
        "Goal at target Turn:\n{goal}\n\nCanonical visible context through target Turn:\n{}\n\nExact immutable diff{}:\n{}",
        context.join("\n"),
        if diff_truncated {
            " (truncated at the configured input limit)"
        } else {
            ""
        },
        diff_text
    ))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut result = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

fn redact_sensitive_text(value: &str) -> String {
    const MARKERS: [&str; 11] = [
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "authorization:",
        "bearer ",
        "password",
        "client_secret",
        "private key",
        "aws_access_key_id",
        "aws_secret_access_key",
    ];
    value
        .split_inclusive('\n')
        .map(|line| {
            let lowercase = line.to_ascii_lowercase();
            if MARKERS.iter().any(|marker| lowercase.contains(marker)) {
                if line.ends_with('\n') {
                    "[redacted sensitive line]\n"
                } else {
                    "[redacted sensitive line]"
                }
            } else {
                line
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn commit_message_context_redacts_credentials_line_by_line() {
        assert_eq!(
            super::redact_sensitive_text("safe\nAuthorization: Bearer value\nstill safe"),
            "safe\n[redacted sensitive line]\nstill safe"
        );
    }
}
