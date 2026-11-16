use ash_install_context::InstallContext;
use ash_sandboxing::SandboxBackends;
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
