//! Static extension package discovery and resource validation shared by product hosts.
//!
//! This crate deliberately does not know about JSON-RPC, Electron, Workbench, TextMate, or
//! extension code execution. Hosts provide trusted package roots, then adapt the resulting domain
//! descriptors and bounded resource bytes to their own transport and presentation layers.

mod catalog;
mod catalog_budget;
mod diagnostic;
mod package;
mod resource;
mod source;

pub use catalog::ExtensionCatalog;
pub use catalog::ExtensionCatalogError;
pub use catalog::ExtensionCatalogReload;
pub use catalog::ExtensionCatalogSnapshot;
pub use catalog::ExtensionDescriptor;
pub use catalog::ExtensionDiagnostic;
pub use catalog::ExtensionDiagnosticCode;
pub use catalog::ExtensionResource;
pub use catalog::ExtensionSourceKind;
pub use source::DynamicExtensionPackageSource;
pub use source::DynamicExtensionSourceProvider;
pub use source::DynamicExtensionSourceSnapshot;
pub use source::ExtensionRoot;
pub use source::ExtensionRootKind;

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
