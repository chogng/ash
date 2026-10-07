//! Discovery and validation of trusted language-server launch definitions.
//!
//! This crate owns built-in server identities, user intent, executable candidate resolution, and
//! availability reporting. It never starts a process, reads an editor document, or runs LSP.

mod css;
mod definition;
mod direct_package;
mod error;
mod node_package;
mod node_runtime;
mod provider;
mod resolver;

/// Stable built-in identity for the Rust language server.
pub const RUST_ANALYZER_SERVER_ID: &str = "rust-analyzer";
/// Stable built-in identity for the VS Code JSON/JSONC language server.
pub const JSON_LANGUAGE_SERVER_ID: &str = "vscode-json-language-server";
/// Stable built-in identity for the Bash and shell-script language server.
pub const BASH_LANGUAGE_SERVER_ID: &str = "bash-language-server";
/// Stable built-in identity for JavaScript and TypeScript language intelligence.
pub const TYPESCRIPT_LANGUAGE_SERVER_ID: &str = "typescript-language-server";
/// Stable provider identity for the Marketplace CSS/SCSS/Less language server.
pub const CSS_LANGUAGE_SERVER_ID: &str = "css-language-server";

pub use css::CssLanguageServerProvider;
pub use definition::LanguageServerDefinition;
pub use direct_package::DirectPackageLanguageServerProvider;
pub use error::LspServerResolverError;
pub use node_package::NodePackageLanguageServerProvider;
pub use node_runtime::ManagedNodeRuntime;
pub use node_runtime::ManagedNodeRuntimeSource;
pub use provider::LanguageServerProvider;
pub use provider::LanguageServerProviderError;
pub use provider::LspServerLaunch;
pub use provider::LspServerProviders;
pub use resolver::{
    LanguageServerExecutableCandidates, LanguageServerExecutionPolicy, LanguageServerMode,
    LanguageServerPreference, LspServerAvailability, LspServerResolution, LspServerResolutionEntry,
    LspServerResolver,
};

/// Compatibility name for the former catalog error.
pub type LanguageServerCatalogError = LspServerResolverError;

/// Compatibility name for the former provider launch selector.
pub type LanguageServerProviderLaunch<'a> = LspServerLaunch<'a>;

/// Compatibility name for the former provider collection.
pub type LanguageServerProviderRegistry = LspServerProviders;

/// Compatibility name for the former resolver.
pub type LanguageServerCatalog = LspServerResolver;

/// Compatibility name for the former resolver entry.
pub type LanguageServerCatalogEntry = LspServerResolutionEntry;

/// Compatibility name for the former resolution result.
pub type LanguageServerCatalogResolution = LspServerResolution;

/// Compatibility name for the former availability state.
pub type LanguageServerCatalogState = LspServerAvailability;
#[cfg(test)]
#[path = "provider_tests.rs"]
mod provider_tests;
