//! Immutable package publication, selection, leasing, and cleanup.

#![deny(unsafe_code)]

mod store;

pub use store::PackageIdentity;
pub use store::PackageLease;
pub use store::PackageStore;
pub use store::PublishedPackage;
pub use store::acquire_package_lease_for_executable;
