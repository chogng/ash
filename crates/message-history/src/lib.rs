//! Local-profile input recall contracts, independent of conversation execution and UI state.

mod client;
mod recall;
pub use client::MessageHistory;
pub use client::MessageHistoryTask;
pub use recall::MessageHistoryRecall;
pub use recall::MessageHistoryRecallEffect;
pub use recall::MessageHistoryRecallStatus;

/// Maximum UTF-8 bytes accepted in one submitted input.
pub const MAX_ENTRY_BYTES: usize = 1024 * 1024;
pub const MAX_PAGE_ENTRIES: u32 = 128;
pub const MAX_PAGE_BYTES: usize = 64 * 1024;

/// The user-selected destination of an input, never inferred from replayed model output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageHistoryKind {
    Agent,
    Shell,
    Command,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageHistorySubmission {
    pub text: String,
    pub kind: MessageHistoryKind,
    /// Informational origin; records are not owned by, or foreign-keyed to, a Thread.
    pub thread_id: Option<String>,
}

impl MessageHistorySubmission {
    pub fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() {
            return Err("Input history cannot contain empty text".into());
        }
        if self.text.len() > MAX_ENTRY_BYTES {
            return Err("Input history entry exceeds 1 MiB".into());
        }
        if self
            .thread_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 512)
        {
            return Err("Input history Thread identity is invalid".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageHistoryEntry {
    /// Monotonic identity that is not reused after trimming or clearing history.
    pub id: u64,
    pub submitted_at_ms: u64,
    pub submission: MessageHistorySubmission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageHistoryQuery {
    /// Exclusive older-page boundary. New appends do not change an existing cursor.
    pub before: Option<u64>,
    /// Literal, Unicode-lowercased substring matching; empty text selects all entries.
    pub text: String,
    pub kind: Option<MessageHistoryKind>,
    pub limit: u32,
}

impl Default for MessageHistoryQuery {
    fn default() -> Self {
        Self {
            before: None,
            text: String::new(),
            kind: None,
            limit: MAX_PAGE_ENTRIES,
        }
    }
}

impl MessageHistoryQuery {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit == 0 || self.limit > MAX_PAGE_ENTRIES || self.text.len() > MAX_ENTRY_BYTES {
            return Err("Input history query exceeds its bounds".into());
        }
        if self
            .before
            .is_some_and(|id| id == 0 || id > i64::MAX as u64)
        {
            return Err("Input history cursor is invalid".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MessageHistoryPage {
    /// Entries in newest-to-oldest order.
    pub entries: Vec<MessageHistoryEntry>,
    pub next_before: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MessageHistoryRetention {
    pub max_entries: u32,
    pub max_bytes: u64,
}

impl Default for MessageHistoryRetention {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_bytes: 8 * 1024 * 1024,
        }
    }
}

impl MessageHistoryRetention {
    pub fn validate(self) -> Result<(), String> {
        if self.max_entries == 0 || self.max_bytes == 0 || self.max_bytes > i64::MAX as u64 {
            return Err("Input history retention must have positive, bounded limits".into());
        }
        Ok(())
    }
}

/// Durable input history for one local profile. Implementations atomically append and trim,
/// preserve stable pagination identities, and keep clearing independent of conversation storage.
/// Calls may block; product hosts must execute them outside the UI event loop.
pub trait MessageHistoryStore: Send + Sync {
    fn append(&self, submission: MessageHistorySubmission) -> Result<MessageHistoryEntry, String>;
    fn read(&self, query: &MessageHistoryQuery) -> Result<MessageHistoryPage, String>;
    fn clear(&self) -> Result<(), String>;
}

#[cfg(test)]
#[path = "recall_tests.rs"]
mod tests;
