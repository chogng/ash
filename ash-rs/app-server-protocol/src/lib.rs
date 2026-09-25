//! External RPC protocol, wire envelopes, and generated contract artifacts.
//!
//! Domain entities deliberately remain private to `ash-core`.

#[cfg(any(test, feature = "export"))]
mod export;
mod listen_info;
mod schema;
mod web;
pub use web::WebLaunchOptions;
pub use web::WebListenInfo;
pub use web::WebSessionInfo;
pub use web::{WebWorkspaceDirectory, WebWorkspaceListRequest, WebWorkspaceListResult, WebWorkspaceOpenRequest};
pub mod protocol;
pub mod rpc;
#[cfg(any(test, feature = "export"))]
mod typescript_decoder;

#[cfg(any(test, feature = "export"))]
pub use export::GENERATED_TYPESCRIPT_HEADER;
#[cfg(any(test, feature = "export"))]
pub use export::JSON_SCHEMA_FIXTURE;
#[cfg(any(test, feature = "export"))]
pub use export::METADATA_FIXTURE;
#[cfg(any(test, feature = "export"))]
pub use export::TYPESCRIPT_FIXTURE_DIRECTORY;
#[cfg(any(test, feature = "export"))]
pub use export::json_schema;
#[cfg(any(test, feature = "export"))]
pub use export::protocol_metadata;
#[cfg(any(test, feature = "export"))]
pub use export::typescript_files;
pub use listen_info::AppServerListenInfo;
pub use listen_info::AppServerListenInfoError;
pub use schema::schema_hash;

#[cfg(test)]
#[path = "schema_fixtures.rs"]
mod tests;

#[cfg(test)]
#[path = "protocol_compatibility_tests.rs"]
mod protocol_compatibility_tests;

#[cfg(not(any(test, feature = "json-schema")))]
pub(crate) use noop_macros::JsonSchema;
#[cfg(not(any(test, feature = "export")))]
pub(crate) use noop_macros::TS;
#[cfg(any(test, feature = "json-schema"))]
pub(crate) use schemars::JsonSchema;
#[cfg(any(test, feature = "export"))]
pub(crate) use ts_rs::TS;
