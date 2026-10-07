//! Durable, user-controlled memories without model or product-host dependencies.

mod model;
mod policy;
mod read;
mod service;
mod store;

pub use model::Memory;
pub use model::MemoryDeleteResult;
pub use model::MemoryId;
pub use model::MemoryListPage;
pub use model::MemoryMutationDisposition;
pub use model::MemoryMutationResult;
pub use model::MemoryScope;
pub use model::MemorySearchMatch;
pub use model::MemorySearchPage;
pub use model::MemorySource;
pub use model::MemorySummary;
pub use policy::MemoryWriteMode;
pub use service::AddMemoryRequest;
pub use service::DeleteMemoryRequest;
pub use service::ListMemoriesRequest;
pub use service::Memories;
pub use service::MemoryError;
pub use service::ReadMemoryRequest;
pub use service::SaveModelMemoryRequest;
pub use service::SearchMemoriesRequest;
pub use service::UpdateMemoryRequest;
pub use store::MemoryAddCommit;
pub use store::MemoryDeleteCommit;
pub use store::MemoryStore;
pub use store::MemoryStoreError;
pub use store::MemoryStoreListRequest;
pub use store::MemoryStorePage;
pub use store::MemoryStoreSearchRequest;
pub use store::MemoryUpdateCommit;

pub use policy::MemoryPolicy;
pub use policy::MemoryPolicyMutationResult;
pub use policy::MemoryReadMode;
pub use policy::UpdateMemoryPolicyRequest;
pub use read::MemoryCitation;
pub use read::MemoryCitationResult;
pub use store::MemoryPolicyCommit;
pub use store::MemoryStoreContextRequest;

#[cfg(test)]
#[path = "memories_tests.rs"]
mod tests;
