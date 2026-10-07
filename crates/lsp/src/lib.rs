//! Language Server Protocol client runtime for Ash product hosts.
//!
//! The crate owns LSP framing, lifecycle, request pairing, document versions, and server event
//! delivery. Editors and product hosts retain file identity, presentation, configuration policy,
//! server selection, restart policy, and user interaction.

mod capability;
mod client;
mod command;
mod document;
mod driver;
mod error;
mod event;
mod options;
mod protocol;
mod raw_client;
mod router;

pub use capability::{LanguageServerCapabilitySnapshot, LanguageServerDynamicRegistration};
pub use client::{LanguageServerClient, LanguageServerInitialization};
pub use command::LanguageServerCommand;
pub use command::LanguageServerEnvironmentPolicy;
pub use document::{
    DocumentChange, DocumentChangeSync, DocumentSave, DocumentSaveSync, DocumentSyncPolicy,
    DocumentVersion,
};
pub use error::LanguageServerError;
pub use event::{
    LanguageServerEvent, LanguageServerHost, NoopLanguageServerHost, WorkspaceConfiguration,
};
pub use lsp_types;
pub use options::{LanguageServerOptions, LanguageServerTimeouts};
pub use router::{
    EditorDocumentRevision, LanguageDocumentSnapshot, LanguageServerDocumentRouter,
    LanguageServerIncarnation, LanguageServerName, LanguageServerPreviousShutdown,
    LanguageServerReplacement, LanguageServerRoute, LanguageServerRouterError,
    LanguageServerShutdownFailure, RoutedDocumentVersion,
};

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "command_tests.rs"]
mod command_tests;

#[cfg(test)]
#[path = "router_tests.rs"]
mod router_tests;
