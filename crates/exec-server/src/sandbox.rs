use ash_install_context::InstallContext;
use ash_sandboxing::SandboxBackends;
use std::path::PathBuf;
use std::sync::Arc;

/// Configures the shared local sandbox candidates without changing caller authority.
pub struct LocalSandbox {
    #[cfg(windows)]
    context: InstallContext,
    mxc: mxc_sandbox::MxcSandbox,
}

impl LocalSandbox {
    pub fn new(context: InstallContext) -> Self {
        Self {
            mxc: mxc_sandbox::MxcSandbox::new(context.clone()),
            #[cfg(windows)]
            context,
        }
    }

    /// Configures the Windows executable that dispatches Ash's internal terminal role.
    /// Unix allocates its terminal through MXC and does not use this host setting.
    pub fn with_pty_helper(self, executable: PathBuf) -> Self {
        #[cfg(windows)]
        {
            Self {
                mxc: self.mxc.with_pty_helper(executable),
                ..self
            }
        }
        #[cfg(not(windows))]
        {
            let _ = executable;
            self
        }
    }

    /// Uses MXC first and, on Windows, the account backend for compatible requests.
    /// SandboxBackends selects before launch and never changes the requested policy.
    pub fn build(self) -> SandboxBackends {
        SandboxBackends::new(vec![
            ("mxc", Arc::new(self.mxc)),
            #[cfg(windows)]
            (
                "windows",
                Arc::new(windows_sandbox::WindowsSandbox::new(self.context)),
            ),
        ])
    }
}

#[cfg(all(test, windows))]
#[path = "sandbox_tests.rs"]
mod tests;
