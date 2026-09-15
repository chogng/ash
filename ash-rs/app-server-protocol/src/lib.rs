//! External RPC protocol, wire envelopes, and generated contract artifacts.
//!
//! Domain entities deliberately remain private to `ash-core`.

mod export;
mod listen_info;
mod web;
pub use web::WebLaunchOptions;
pub use web::WebListenInfo;
pub use web::WebSessionInfo;
pub mod protocol;
pub mod rpc;
mod typescript_decoder;

pub use export::GENERATED_TYPESCRIPT_HEADER;
pub use export::JSON_SCHEMA_FIXTURE;
pub use export::TYPESCRIPT_FIXTURE_DIRECTORY;
pub use export::json_schema;
pub use export::schema_hash;
pub use export::typescript_files;
pub use listen_info::AppServerListenInfo;
pub use listen_info::AppServerListenInfoError;

#[cfg(test)]
#[path = "schema_fixtures.rs"]
mod tests;

#[cfg(test)]
#[path = "protocol_compatibility_tests.rs"]
mod protocol_compatibility_tests;
