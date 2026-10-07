//! Shared Remote identity and launch contracts.
//!
//! This crate models a Remote target without selecting an SSH implementation, spawning a
//! process, or owning product UI state. Host products use these values to describe the same
//! target to their connection manager, while `ash-remote-server` owns the remote runtime.

mod launch;
mod platform;
mod target;

pub use launch::remote_app_server_command;
pub use platform::RemoteArchitecture;
pub use platform::RemoteLinuxLibc;
pub use platform::RemotePlatform;
pub use target::RemoteAddressError;
pub use target::RemoteDirPath;
pub use target::RemoteProfile;
pub use target::RemoteRuntime;
pub use target::SshHost;
pub use target::SshTarget;

#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "platform_tests.rs"]
mod platform_tests;
