//! Static extension package discovery and resource validation shared by product hosts.
//!
//! This module deliberately does not know about JSON-RPC, Electron, Workbench, TextMate, or
//! extension code execution. Hosts provide trusted package roots, then adapt the resulting domain
//! descriptors and bounded resource bytes to their own transport and presentation layers.

mod budget;
mod diagnostic;
mod package;
mod packages;
mod resource;
mod source;

pub use packages::ExtensionDescriptor;
pub use packages::ExtensionDiagnostic;
pub use packages::ExtensionDiagnosticCode;
pub use packages::ExtensionPackages;
pub use packages::ExtensionPackagesError;
pub use packages::ExtensionPackagesReload;
pub use packages::ExtensionPackagesSnapshot;
pub use packages::ExtensionResource;
pub use packages::ExtensionSourceKind;
pub use source::DynamicExtensionPackageSource;
pub use source::DynamicExtensionSourceProvider;
pub use source::DynamicExtensionSourceSnapshot;
pub use source::ExtensionRoot;
pub use source::ExtensionRootKind;

#[cfg(test)]
#[path = "packages_tests.rs"]
mod tests;
