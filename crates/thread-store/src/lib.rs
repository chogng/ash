//! Storage-neutral durable Thread history boundary.

mod error;
mod history_reader;
mod recent_tool_calls;
mod store;

pub use error::ThreadStoreError;
pub use history_reader::ThreadHistoryReader;
pub use recent_tool_calls::MAX_RECENT_ARGUMENT_BYTES;
pub use recent_tool_calls::MAX_RECENT_ARGUMENT_TOTAL_BYTES;
pub use recent_tool_calls::MAX_RECENT_TOOL_CALLS;
pub use recent_tool_calls::RecentToolCall;
pub use recent_tool_calls::RecentToolCalls;
pub use recent_tool_calls::RecentToolCallsQuery;
pub use store::AppendBatchResult;
pub use store::ThreadCatalogRecord;
pub use store::ThreadEventBatch;
pub use store::ThreadEventPage;
pub use store::ThreadExecutionBinding;
pub use store::ThreadStore;
pub use store::session_from_catalog;
pub use store::validate_append_batch;
pub use store::validate_binding_source;
