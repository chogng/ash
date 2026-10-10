use crate::ThreadCatalogRecord;
use crate::ThreadEventPage;
use crate::ThreadStore;
use crate::ThreadStoreError;
use ash_history::HistoryPrefix;
use ash_history::StoredEvent;
use ash_protocol::HistoryPrefixRef;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

/// Read-only access to the canonical history, including retained immutable prefixes.
/// Consumers cannot mutate business state through this port or own a competing history copy.
pub trait ThreadHistoryReader: Send + Sync {
    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError>;
    fn load(&self, thread_id: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError>;
    fn load_range(
        &self,
        thread_id: &ThreadId,
        after: u64,
        limit: usize,
    ) -> Result<ThreadEventPage, ThreadStoreError>;
    fn load_history_prefix(
        &self,
        prefix: &HistoryPrefixRef,
    ) -> Result<HistoryPrefix, ThreadStoreError>;
}

impl<T: ThreadStore + Send + Sync + ?Sized> ThreadHistoryReader for T {
    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError> {
        ThreadStore::session_catalog(self, session_id)
    }
    fn load(&self, thread_id: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError> {
        ThreadStore::load(self, thread_id)
    }
    fn load_range(
        &self,
        thread_id: &ThreadId,
        after: u64,
        limit: usize,
    ) -> Result<ThreadEventPage, ThreadStoreError> {
        ThreadStore::load_range(self, thread_id, after, limit)
    }
    fn load_history_prefix(
        &self,
        prefix: &HistoryPrefixRef,
    ) -> Result<HistoryPrefix, ThreadStoreError> {
        ThreadStore::load_history_prefix(self, prefix)
    }
}
