//! Reusable Remote transport and persistence primitives.
//!
//! The crate starts the local OpenSSH client, binds its stdio stream to an App Server session, and
//! owns the catalog/profile and runtime installation primitives. It deliberately owns no
//! credentials, Renderer state, lifecycle recovery policy, or Remote server installation policy.
//! Product-neutral lifecycle coordination is provided by `ash-remote-host`; a remote runtime
//! never initiates SSH.

mod catalog;
mod connection_catalog;
mod install;
mod runtime_updater;
mod ssh;
mod tunnel;

pub use ash_remote_profile_store::RemoteConnectionProfileRecord;
pub use ash_remote_profile_store::RemoteConnectionProfileStore;
pub use ash_remote_profile_store::RemoteConnectionProfileStoreError;
pub use ash_remote_profile_store::RemoteConnectionProfileStoreFailureKind;
pub use catalog::RemoteRuntimeCatalog;
pub use catalog::RemoteRuntimeCatalogError;
pub use connection_catalog::RemoteConnectionCatalog;
pub use connection_catalog::RemoteConnectionCatalogError;
pub use connection_catalog::RemoteConnectionCatalogFailureKind;
pub use connection_catalog::RemoteConnectionEntry;
pub use connection_catalog::RemoteConnectionName;
pub use connection_catalog::RemoteConnectionNameError;
pub use connection_catalog::RemoteConnectionSaveMode;
pub use install::RemoteInstalledRuntime;
pub use install::RemoteRuntimeArtifact;
pub use install::RemoteRuntimeArtifactError;
pub use install::RemoteRuntimeArtifactIntegrity;
pub use install::RemoteRuntimeInstallDisposition;
pub use install::RemoteRuntimeInstallError;
pub use install::RemoteRuntimeInstallFailureKind;
pub use install::RemoteRuntimeInstallLocation;
pub use install::RemoteRuntimeInstallProgress;
pub use install::RemoteRuntimeInstallRoot;
pub use install::RemoteRuntimeVersion;
pub use install::SshRemoteRuntimeInstaller;
pub use runtime_updater::RemoteRuntimeCatalogRelease;
pub use runtime_updater::RemoteRuntimeCatalogUpdater;
pub use runtime_updater::RemoteRuntimeDownloadCache;
pub use runtime_updater::RemoteRuntimeDownloadDisposition;
pub use runtime_updater::RemoteRuntimeDownloadProgress;
pub use runtime_updater::RemoteRuntimeUpdateError;
pub use ssh::RemoteConnectionError;
pub use ssh::RemoteConnectionFailureKind;
pub use ssh::RemoteRuntimeProbe;
pub use ssh::SshAppServerConnectionOptions;
pub use ssh::remote_app_server_command;
pub use tunnel::SshTunnel;
pub use tunnel::SshTunnelCommand;
pub use tunnel::SshTunnelDiagnostics;
pub use tunnel::SshTunnelError;
pub use tunnel::SshTunnelOptions;
pub use tunnel::SshTunnelReadiness;
pub use tunnel::select_available_loopback_port;

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod catalog_tests;

#[cfg(test)]
#[path = "connection_catalog_tests.rs"]
mod connection_catalog_tests;

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "tunnel_tests.rs"]
mod tunnel_tests;

#[cfg(test)]
#[path = "install_tests.rs"]
mod install_tests;

#[cfg(test)]
#[path = "runtime_updater_tests.rs"]
mod runtime_updater_tests;

mod command;
pub use command::run_command;
