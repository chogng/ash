use crate::NotesStore;
use ash_core::ThreadController;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Weak;
use tools::ToolConcurrency;
use tools::ToolContent;
use tools::ToolDefinition;
use tools::ToolExecutionFuture;
use tools::ToolExecutionOutcome;
use tools::ToolExecutor;
use tools::ToolInputSchema;
use tools::ToolInvocation;
use tools::ToolLoading;
use tools::ToolName;
use tools::ToolOutput;
use tools::ToolOutputSchema;
use tools::ToolPayload;
use tools::ToolSchemaMode;
use tools::ToolStartFailure;

pub(crate) struct HistoryTool {
    name: &'static str,
    threads: Weak<ThreadController>,
    notes: Arc<NotesStore>,
}
impl HistoryTool {
    pub(crate) fn new(
        name: &'static str,
        threads: Weak<ThreadController>,
        notes: Arc<NotesStore>,
    ) -> Self {
        Self {
            name,
            threads,
            notes,
        }
    }
    fn run(&self, invocation: &ToolInvocation) -> Result<Value, String> {
        let cancellation = invocation.context().cancellation();
        cancellation.check().map_err(|e| e.reason().to_string())?;
        let session = invocation
            .context()
            .session_id()
            .ok_or("History requires a bound Session")?;
        let thread = invocation
            .context()
            .thread_id()
            .ok_or("History requires a bound Thread")?;
        let threads = self.threads.upgrade().ok_or("Thread owner has stopped")?;
        let snapshot = threads.read_thread(thread).map_err(|e| e.to_string())?;
        if &snapshot.session_id != session
            || !snapshot
                .turns
                .iter()
                .any(|turn| turn.turn_id.as_str() == invocation.turn_id().as_str())
        {
            return Err("History caller does not own this Thread/Turn".into());
        }
        let ToolPayload::FunctionArguments(value) = invocation.payload() else {
            return Err("History requires function arguments".into());
        };
        let args = value
            .as_object()
            .ok_or("History arguments must be an object")?;
        let allowed: &[&str] = match self.name {
            "history_list" => &["offset"],
            "history_read" => &["item_id", "offset"],
            "history_search" | "notes_search" => &["query"],
            "notes_list" => &[],
            "notes_read" => &["path", "offset"],
            "notes_write" => &["path", "body", "expected_revision"],
            _ => return Err("Unknown history operation".into()),
        };
        if args.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("Unknown history argument".into());
        }
        let string = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{key} must be non-empty text"))
        };
        let offset = match args.get("offset") {
            Some(value) => usize::try_from(
                value
                    .as_u64()
                    .ok_or("offset must be a non-negative integer")?,
            )
            .map_err(|_| "offset exceeds the platform limit")?,
            None => 0,
        };
        let result = match self.name {
            "history_list" => {
                let offset = match args.get("offset") {
                    Some(value) => value
                        .as_u64()
                        .ok_or("offset must be a non-negative integer")?,
                    None => 0,
                };
                let offset = usize::try_from(offset).map_err(|_| "offset is too large")?;
                let items = snapshot
                    .items
                    .iter()
                    .skip(offset)
                    .take(100)
                    .map(|item| json!({"item_id":item.item_id(),"turn_id":item.turn_id()}))
                    .collect::<Vec<_>>();
                json!({"items":items,"next_offset":(offset.saturating_add(100)<snapshot.items.len()).then_some(offset.saturating_add(100))})
            }
            "history_read" => {
                let id = string("item_id")?;
                let item = snapshot
                    .items
                    .iter()
                    .find(|item| item.item_id().as_str() == id)
                    .ok_or("History item was not found")?;
                page(
                    &serde_json::to_string(item).map_err(|e| e.to_string())?,
                    offset,
                )?
            }
            "history_search" => {
                let query = string("query")?;
                if query.len() > 2048 {
                    return Err("query exceeds 2048 bytes".into());
                }
                let mut items = Vec::new();
                for item in &snapshot.items {
                    let text = serde_json::to_string(item).map_err(|e| e.to_string())?;
                    if text.contains(query) {
                        items.push(json!({"item_id":item.item_id(),"excerpt":text.chars().take(1000).collect::<String>()}));
                        if items.len() == 50 {
                            break;
                        }
                    }
                }
                json!({"items":items})
            }
            "notes_write" => {
                let note = self.notes.write(
                    session,
                    thread,
                    string("path")?,
                    string("body")?,
                    args.get("expected_revision")
                        .and_then(Value::as_i64)
                        .ok_or("expected_revision must be a non-negative integer")?,
                    cancellation,
                )?;
                json!({"path":note.path,"revision":note.revision})
            }
            name => {
                let notes = self.notes.list(session, thread)?;
                match name {
                    "notes_list" => {
                        json!({"notes":notes.iter().map(|note|json!({"path":note.path,"revision":note.revision})).collect::<Vec<_>>()})
                    }
                    "notes_read" => {
                        let path = string("path")?;
                        let note = notes
                            .iter()
                            .find(|note| note.path == path)
                            .ok_or("Note was not found")?;
                        json!({"path":note.path,"revision":note.revision,"page":page(&note.body,offset)?})
                    }
                    "notes_search" => {
                        let query = string("query")?;
                        if query.len() > 2048 {
                            return Err("query exceeds 2048 bytes".into());
                        }
                        json!({"notes":notes.iter().filter(|note|note.body.contains(query)||note.path.contains(query)).take(50).map(|note|json!({"path":note.path,"revision":note.revision,"excerpt":note.body.chars().take(1000).collect::<String>()})).collect::<Vec<_>>()})
                    }
                    _ => return Err("Unknown note operation".into()),
                }
            }
        };
        cancellation.check().map_err(|e| e.reason().to_string())?;
        if serde_json::to_vec(&result)
            .map_err(|e| e.to_string())?
            .len()
            > 1_100_000
        {
            return Err("History result exceeds its read limit".into());
        }
        Ok(result)
    }
}
impl ToolExecutor for HistoryTool {
    fn definition(&self) -> ToolDefinition {
        let properties = match self.name {
            "history_list" => json!({"offset":{"type":"integer","minimum":0}}),
            "history_read" => {
                json!({"item_id":{"type":"string"},"offset":{"type":"integer","minimum":0}})
            }
            "history_search" | "notes_search" => {
                json!({"query":{"type":"string","maxLength":2048}})
            }
            "notes_read" => {
                json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0}})
            }
            "notes_write" => {
                json!({"path":{"type":"string"},"body":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}})
            }
            _ => json!({}),
        };
        let required = properties
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ToolDefinition::function(ToolName::new(self.name).unwrap(),"Read earlier conversation or maintain task notes for the current Thread across context resets. Notes use virtual relative paths. Reads use character offsets and return at most 16000 characters with next_offset. Read before updating; expected_revision 0 creates a note. Record task progress and verified findings, never credentials.",ToolInputSchema::parse(json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})).unwrap(),ToolOutputSchema::Unspecified,ToolSchemaMode::Strict,ToolLoading::Eager).expect("valid history tool definition")
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }
    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            if invocation.binding().exposed_name().as_str() != self.name {
                return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                    "History tool binding mismatch",
                ));
            }
            match self.run(&invocation) {
                Ok(value) => {
                    ToolExecutionOutcome::Returned(ToolOutput::success(vec![ToolContent::Text(
                        value.to_string(),
                    )]))
                }
                Err(error) => {
                    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ToolContent::Text(
                        error,
                    )]))
                }
            }
        })
    }
}

fn page(text: &str, offset: usize) -> Result<Value, String> {
    let count = text.chars().count();
    if offset > count {
        return Err("read offset exceeds content length".into());
    }
    let content = text.chars().skip(offset).take(16_000).collect::<String>();
    let next = offset + content.chars().count();
    Ok(json!({"content":content,"next_offset":(next<count).then_some(next)}))
}
