pub(crate) mod agent_tools;
mod runtime;

use std::path::PathBuf;

pub(crate) use runtime::GitHubExtensionRuntime;

pub(crate) fn product_executable() -> Option<PathBuf> {
    let installation = ash_install_context::InstallContext::current();
    Some(
        installation
            .package_layout()?
            .binary_directory()
            .join(if cfg!(windows) {
                "ash-github-extension.exe"
            } else {
                "ash-github-extension"
            }),
    )
}
