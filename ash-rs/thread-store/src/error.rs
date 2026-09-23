use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThreadStoreError {
    InvalidBatch(String),
    SequenceConflict { expected: u64, actual: u64 },
    CatalogDamaged(ThreadId),
    SessionCatalogDamaged(SessionId),
    Storage(String),
}

impl fmt::Display for ThreadStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBatch(message) => {
                write!(formatter, "invalid Thread event batch: {message}")
            }
            Self::SequenceConflict { expected, actual } => {
                write!(
                    formatter,
                    "Thread sequence conflict: expected {expected}, actual {actual}"
                )
            }
            Self::CatalogDamaged(thread_id) => {
                write!(formatter, "Thread catalog record is damaged: {thread_id}")
            }
            Self::SessionCatalogDamaged(session_id) => {
                write!(formatter, "Session catalog record is damaged: {session_id}")
            }
            Self::Storage(message) => write!(formatter, "Thread storage error: {message}"),
        }
    }
}

impl std::error::Error for ThreadStoreError {}
