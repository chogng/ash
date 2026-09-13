//! Windows account execution, explicit installation, and execution-owned cleanup.
#[cfg(windows)]
extern crate windows_sys_061 as windows_sys;

#[cfg(windows)]
mod windows;

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
