//! Provider-neutral secret persistence primitives.
//!
//! This crate stores opaque secret bytes under opaque keys. Authentication protocols, token
//! refresh, account metadata, credential scope, and request-header construction belong to the
//! domain runtime that consumes those bytes.

mod error;
mod file;
mod memory;
mod store;
mod value;

pub use error::SecretStoreError;
pub use error::SecretStoreErrorKind;
pub use file::FileSecretStore;
pub use memory::MemorySecretStore;
pub use store::DeleteSecretOutcome;
pub use store::SecretStore;
pub use store::UnavailableSecretStore;
pub use value::InvalidSecretKey;
pub use value::SecretKey;
pub use value::SecretValue;

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
