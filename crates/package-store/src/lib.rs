//! Immutable package publication, selection, leasing, and cleanup.

#![deny(unsafe_code)]

mod store;

pub use store::PackageIdentity;
pub use store::PackageLease;
pub use store::PackageStore;
pub use store::PublishedPackage;
pub use store::acquire_package_lease_for_executable;
pub use store::validate_package_identity;

#[cfg(feature = "installation")]
mod installation;
#[cfg(feature = "installation")]
pub use installation::CapabilityInstallError;
#[cfg(feature = "installation")]
pub use installation::CapabilitySource;
#[cfg(feature = "installation")]
pub use installation::install_capability;
#[cfg(feature = "installation")]
pub use installation::validate_capability_package;

#[cfg(feature = "installation")]
pub use installation::resolve_capability_executable;
