use ash_protocol::{SessionId, ThreadId};
use ash_thread_store::ThreadStoreError;
use std::fmt;

/// Failure while reading a durable rollout into a trace artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RolloutTraceError {
    SessionNotFound(SessionId),
    ThreadList(ThreadStoreError),
    ThreadStore {
        thread_id: ThreadId,
        source: ThreadStoreError,
    },
}

impl fmt::Display for RolloutTraceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionNotFound(session_id) => {
                write!(formatter, "Session not found: {session_id}")
            }
            Self::ThreadList(error) => write!(formatter, "failed to list Threads: {error}"),
            Self::ThreadStore { thread_id, source } => {
                write!(formatter, "failed to read Thread {thread_id}: {source}")
            }
        }
    }
}

impl std::error::Error for RolloutTraceError {}
