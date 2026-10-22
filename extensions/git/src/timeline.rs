use crate::GitRuntime;
use crate::api::decode;
use crate::api::invalid;
use crate::changes::relative_resource;
use crate::model::Repository;
use crate::paths::RepoPath;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineOptions {
    cursor: Option<String>,
    limit: Option<TimelineLimit>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TimelineLimit {
    Count(usize),
    Anchor { timestamp: i64, id: Option<String> },
}

impl GitRuntime {
    /// The SCM registration owns this capability and its cancellable requests.
    pub(crate) fn file_timeline(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let resource: String = decode(payload["resource"].clone())?;
        let Some(path) = relative_resource(repository, &resource) else {
            return Ok(Value::Null);
        };
        match payload["methodName"].as_str() {
            Some("provide") => {
                let options: TimelineOptions = decode(payload["options"].clone())?;
                let limit = page_size(&options)?;
                let authored =
                    repository.configuration.text("timeline.date", "committed") == "authored";
                let show_author = repository
                    .configuration
                    .boolean("timeline.showAuthor", true);
                let mut items = Vec::new();
                if options.cursor.is_none()
                    && repository
                        .configuration
                        .boolean("timeline.showUncommitted", false)
                {
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if let Some(change) = repository
                        .status
                        .as_ref()
                        .and_then(|status| status.changes.iter().find(|change| change.path == path))
                    {
                        for (handle, changed, label) in [
                            (
                                "changes",
                                change.worktree_status != "unmodified",
                                "git.uncommittedChanges",
                            ),
                            (
                                "staged",
                                change.index_status != "unmodified",
                                "git.stagedChanges",
                            ),
                        ] {
                            if changed {
                                items.push(json!({"handle":handle,"label":self.api.text(label,&[]),"timestamp":timestamp,"icon":"git-commit"}));
                            }
                        }
                    }
                }
                let mut cursor = options.cursor.clone();
                loop {
                    let history = self.api.file_history(
                        repository,
                        &path,
                        limit,
                        cursor.as_deref(),
                        token,
                    )?;
                    let reached_anchor = match &options.limit {
                        Some(TimelineLimit::Anchor { timestamp, id }) => {
                            history.items.iter().any(|item| {
                                let time = if authored {
                                    item.author_time
                                } else {
                                    item.commit_time
                                };
                                time.saturating_mul(1000) <= *timestamp
                                    && id.as_ref().is_none_or(|id| {
                                        *id == item.object_id
                                            || *id == json!([item.object_id, item.path]).to_string()
                                    })
                            })
                        }
                        _ => true,
                    };
                    items.extend(history.items.iter().map(|item| {
                        let timestamp = if authored {
                            item.author_time
                        } else {
                            item.commit_time
                        };
                        json!({
                            "handle":json!([item.object_id,item.path]).to_string(),
                            "id":item.object_id,
                            "label":item.subject,"timestamp":timestamp.saturating_mul(1000),
                            "description":if show_author {item.author_name.as_str()} else {""},
                            "icon":"git-commit"
                        })
                    }));
                    cursor = history.next_cursor;
                    if reached_anchor || cursor.is_none() {
                        break;
                    }
                }
                let mut page = items;
                if page.iter().any(|item| item["id"].is_string()) {
                    let catalog = json!(self.api.history_refs(repository, Some(token))?);
                    let references = catalog["references"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    for item in &mut page {
                        if !item["id"].is_string() {
                            continue;
                        }
                        // File entries omit graph topology; opening changes resolves the first parent.
                        // Both presentations use the same commit summary and remote actions.
                        item["historyItem"] = crate::history::history_item(
                            &json!({
                                "objectId":item["id"], "parentObjectIds":[],
                                "subject":item["label"],
                                "timestampSeconds":item["timestamp"].as_i64().unwrap_or(0) / 1000
                            }),
                            &references,
                            &catalog["remotes"],
                            repository.configuration.number("commitShortHashLength", 7) as usize,
                        );
                    }
                }
                if !page.is_empty() {
                    let dates = self.api.editor(
                        json!({"method":"formatTimestamps","timestamps":page.iter().map(|item|item["timestamp"].clone()).collect::<Vec<_>>()}),
                        Some(token),
                    )?;
                    for (index, item) in page.iter_mut().enumerate() {
                        let author = item["description"].as_str().unwrap_or_default();
                        let date = dates[index]["relative"].as_str().unwrap_or_default();
                        item["description"] = json!(format!("{author} {date}").trim());
                    }
                }
                Ok(json!({"items":page,"cursor":cursor}))
            }
            Some("open") => {
                let handle: String = decode(payload["handle"].clone())?;
                if handle == "staged" || handle == "changes" {
                    return self.open_change(
                        repository,
                        &json!({"resourceId":format!("{handle}:{path}")}),
                        token,
                    );
                }
                // The file history records the path at each commit, including before a rename.
                let (id, historical_path): (String, RepoPath) = serde_json::from_str(&handle)
                    .map_err(|_| invalid("Invalid Git timeline entry"))?;
                let changes = self.api.commit_changes(repository, &id, token)?;
                let selected = changes
                    .changes
                    .into_iter()
                    .find(|change| change.path == historical_path)
                    .ok_or_else(|| invalid("Git timeline entry no longer contains this file"))?;
                let parent = changes.parent_object_id.as_deref();
                let file =
                    self.api
                        .commit_file(repository, &id, &historical_path, parent, token)?;
                let original_path = selected
                    .original_path
                    .as_deref()
                    .unwrap_or(&historical_path);
                let original = crate::changes::content_input(
                    &file.original,
                    crate::history::commit_file_uri(
                        &repository.descriptor.id,
                        parent.unwrap_or("root"),
                        original_path,
                        "original",
                    ),
                    original_path,
                );
                let mut modified = crate::changes::content_input(
                    &file.modified,
                    crate::history::commit_file_uri(
                        &repository.descriptor.id,
                        &id,
                        &historical_path,
                        "modified",
                    ),
                    &historical_path,
                );
                // Follow the working file while the editor model reads the immutable snapshot.
                modified["preferredResource"] = json!(resource);
                let short = id.chars().take(7).collect::<String>();
                let input = json!({"kind":if file.original.is_binary() || file.modified.is_binary() {"binaryDiff"} else {"diff"},"original":original,"modified":modified,"label":self.api.text("git.timelineComparison",&[&historical_path,&short])});
                self.api.editor(
                    json!({"method":"open","input":input,"options":{"pinned":true}}),
                    Some(token),
                )
            }
            _ => Err(invalid("Unsupported Git timeline operation")),
        }
    }
}

fn page_size(options: &TimelineOptions) -> Result<usize, ExtensionError> {
    match options.limit {
        Some(TimelineLimit::Count(0)) => Err(invalid("Invalid Git timeline page size")),
        Some(TimelineLimit::Count(limit)) => Ok(limit.min(1000)),
        Some(TimelineLimit::Anchor { .. }) | None => Ok(50),
    }
}

#[cfg(test)]
#[path = "timeline_tests.rs"]
mod tests;
