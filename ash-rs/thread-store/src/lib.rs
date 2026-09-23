//! Storage-neutral durable Thread history boundary.

mod error;
mod store;

pub use error::ThreadStoreError;
pub use store::AppendBatchResult;
pub use store::ThreadCatalogRecord;
pub use store::ThreadEventBatch;
pub use store::ThreadStore;
pub use store::session_from_catalog;
pub use store::validate_append_batch;
pub use store::validate_binding_source;
