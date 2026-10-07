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
mod scope;
pub use backends::SandboxBackends;
pub use model::FileSystemIsolation;
pub use model::HostAclChanges;
pub use model::SandboxLaunch;
pub use process::ProcessHandle;
pub use process::SandboxProcess;

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
