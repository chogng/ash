use ash_history::StoredEvent;
use ash_protocol::SessionId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use std::path::PathBuf;

pub const MAX_RECENT_TOOL_CALLS: usize = 20_000;
pub const MAX_RECENT_ARGUMENT_BYTES: usize = 32 * 1024;
pub const MAX_RECENT_ARGUMENT_TOTAL_BYTES: usize = 8 * 1024 * 1024;

/// History lookup stays within one authorized local execution directory. A Project association
/// does not grant access to another root, and imported remote history is not local activity.
#[derive(Clone, Debug)]
pub struct RecentToolCallsQuery {
    pub root: PathBuf,
    pub since_unix_ms: u64,
    pub until_unix_ms: u64,
    pub sessions: u32,
    pub commands_per_session: u32,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecentToolCalls {
    pub calls: Vec<RecentToolCall>,
    pub sessions_available: u64,
    pub commands_available: u64,
}

/// Tool input provenance without user messages, tool output, or model reasoning.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecentToolCall {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: ToolCallId,
    pub sequence: u64,
    pub recorded_at_unix_ms: u64,
    pub name: String,
    pub arguments_json: String,
}

impl RecentToolCall {
    pub fn from_event(session_id: &SessionId, event: &StoredEvent) -> Option<Self> {
        let ThreadEvent::ItemCompleted {
            item:
                ThreadItem::ToolCall {
                    name,
                    arguments_json,
                    turn_id,
                    tool_call_id,
                    ..
                },
            ..
        } = &event.event
        else {
            return None;
        };
        if !matches!(
            name.as_str(),
            "exec_command" | "shell" | "run_command" | "shell-command" | "shell-session"
        ) || arguments_json.len() > MAX_RECENT_ARGUMENT_BYTES
        {
            return None;
        }
        Some(Self {
            session_id: session_id.clone(),
            thread_id: event.thread_id.clone(),
            turn_id: turn_id.clone(),
            tool_call_id: tool_call_id.clone(),
            sequence: event.sequence,
            recorded_at_unix_ms: event.recorded_at.0.try_into().ok()?,
            name: name.to_string(),
            arguments_json: arguments_json.clone(),
        })
    }
}
