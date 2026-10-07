//! Windows account execution, explicit installation, and execution-owned cleanup.
#[cfg(windows)]
extern crate windows_sys_061 as windows_sys;

#[cfg(windows)]
pub(crate) mod windows;

pub mod provisioning;

/// Starts a product-owned 64-bit process with a private restricted token, an AppContainer
/// without capabilities and a single-process kill-on-close job. Only the initial thread
/// receives temporary startup authority to read the package. The trusted entry point must
/// call [`finish_locked_process_startup`] before evaluating third-party code. No account
/// provisioning, administrator rights or product-install ACL changes are required.
/// The process handle removes the launch's package ACL grants and AppContainer on drop.
#[cfg(windows)]
pub use windows::locked_process::spawn as spawn_locked_process;

/// Permanently releases the startup thread's impersonation token after attesting the
/// primary token, job and mitigation settings installed by [`spawn_locked_process`].
/// Worker threads already use the locked primary token from their creation.
#[cfg(windows)]
pub use windows::locked_process::finish_startup as finish_locked_process_startup;

use ash_file_access::Dir;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;

/// Selects a separately provisioned Windows identity and retains it for one process tree.
pub struct WindowsSandbox {
    installation: ash_install_context::InstallContext,
}

impl WindowsSandbox {
    pub fn new(installation: ash_install_context::InstallContext) -> Self {
        Self { installation }
    }
}

impl SandboxBackend for WindowsSandbox {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn requires_shared_network_proxy(&self) -> bool {
        true
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        dir: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare_scoped(command, policy, &SandboxScope::single(dir.clone()))
    }

    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        #[cfg(windows)]
        {
            windows::prepare(&self.installation, command, policy, scope)
        }
        #[cfg(not(windows))]
        {
            let _ = (&self.installation, command, policy, scope);
            Err(SandboxError::UnsupportedPolicy(
                "Windows account execution requires Windows".into(),
            ))
        }
    }
}

/// Runs the explicit operator interface. Preparing ordinary commands never calls this entry point.
pub fn run(arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::run(arguments)
    }
    #[cfg(not(windows))]
    {
        let _ = arguments;
        Err("Windows sandbox installation requires Windows".into())
    }
}
