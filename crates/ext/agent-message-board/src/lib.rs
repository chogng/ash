//! Shared, persistent conversations for members of an Ash agent tree.
mod api;
mod extension;
mod model;
mod remote;
mod store;
mod tools;

pub use api::BoardBackend;
pub use api::BoardNotification;
pub use api::LiveNotices;
pub use extension::install;
pub use extension::tree_members;
pub use model::Commit;
pub use model::Read as ReadRequest;
pub use model::Scope;
pub use model::Subscription;
pub use model::Write as WriteRequest;
pub use remote::API_PATH;
pub use remote::AccessToken;
pub use remote::BoardCall;
pub use remote::BoardOperation;
pub use remote::MAX_BODY;
pub use remote::MemberRegistration;
pub use remote::NotificationWatch;
pub use remote::ServiceFailure;
pub use store::Store;
pub use store::Unread;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Input(String),
    #[error("message-board database: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("message-board encoding: {0}")]
    Encoding(#[from] serde_json::Error),
    #[error("message-board runtime: {0}")]
    Runtime(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
#[path = "extension_tests.rs"]
mod extension_tests;
#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
