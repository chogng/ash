//! Cross-platform sandbox policy and backend coordination.
//!
//! Owns policy, directory scopes, process lifecycle, and the resolution of a
//! scope into the concrete filesystem view shared by every backend and file
//! tool. Canonical path handling delegates to the file-access layer.

mod backends;
mod dir;
mod error;
mod filesystem;
mod filesystem_snapshot;
mod manager;
mod model;
mod process;
mod pty;
mod scope;
pub use backends::SandboxBackends;
pub use backends::SandboxDiagnostic;
pub use backends::SandboxReadiness;
pub use model::FileSystemIsolation;
pub use model::HostAclChanges;
pub use model::SandboxLaunch;
pub use process::ProcessHandle;
pub use process::SandboxProcess;
#[cfg(windows)]
pub use process::windows_command_line;

pub use dir::PROTECTED_DIR_METADATA_NAMES;
pub use error::SandboxError;
pub use filesystem::HostReadScope;
pub use filesystem::MissingPathBehavior;
pub use filesystem::PatternMatchTiming;
pub use filesystem::ResolvedFileSystem;
pub use filesystem::SandboxPathAccess;
pub use filesystem::SandboxPathRule;
pub use filesystem::reject_linked_file;
pub use filesystem_snapshot::FilesystemSnapshot;
pub use manager::{SandboxBackend, SandboxManager};
pub use model::{
    FileSystemAccess, ManagedNetworkAccess, NetworkAccess, PreparedCommand, ProcessIo,
    SandboxCommand, SandboxDenialTiming, SandboxKind, SandboxPolicy, SandboxProcessDenial,
    SandboxProcessExitStatus,
};
pub use scope::SandboxDirAccess;
pub use scope::SandboxDirGrant;
pub use scope::SandboxScope;

#[cfg(windows)]
extern crate windows_sys_061 as windows_sys;
#[cfg(windows)]
mod locked_process;
/// Sources the trusted startup thread must load before releasing its authority.
#[cfg(windows)]
#[derive(Clone, Copy)]
pub enum LockedProcessSources {
    /// Read the installed package rooted at the command's working directory.
    Package,
    /// Use only module bytes compiled into the executable, without filesystem grants.
    Embedded,
}

/// Starts a product-owned 64-bit process with a private restricted token, an AppContainer
/// without capabilities and a single-process kill-on-close job. Only the initial thread
/// receives temporary startup authority to read the package. The trusted entry point must
/// call [`finish_locked_process_startup`] before evaluating third-party code. No account
/// provisioning, administrator rights or product-install ACL changes are required.
/// The process handle removes the launch's package ACL grants and AppContainer on drop.
/// Embedded sources require no package ACL changes, regardless of the working directory.
#[cfg(windows)]
pub use locked_process::spawn as spawn_locked_process;

/// Permanently releases the startup thread's impersonation token after attesting the
/// primary token, job and mitigation settings installed by [`spawn_locked_process`].
/// Worker threads already use the locked primary token from their creation.
#[cfg(windows)]
pub use locked_process::finish_startup as finish_locked_process_startup;
