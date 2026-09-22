//! Shared, persistent conversations for members of an Ash agent tree.
mod extension;
mod model;
mod store;
mod tools;

pub use extension::install;
pub use store::Store;

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

type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
#[path = "extension_tests.rs"]
mod extension_tests;
#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
