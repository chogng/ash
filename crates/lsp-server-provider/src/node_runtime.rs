use std::env;
use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;

use ash_install_context::InstallContext;
use ash_lsp::LanguageServerCommand;

use crate::LanguageServerProviderError;
use crate::provider::canonical_executable;
use crate::provider::canonical_regular_file;

const SAFE_NODE_ENVIRONMENT: &[&str] = &[
    "HOME",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
];
const ELECTRON_RUN_AS_NODE_PATH: &str = "ASH_ELECTRON_RUN_AS_NODE_PATH";

/// Provenance and invocation mode for one managed Node-compatible runtime.
///
/// Providers use this distinction only to construct the exact child environment. They must not
/// branch on the host product or move process supervision outside the shared Rust runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedNodeRuntimeSource {
    /// A standalone Node executable supplied by the signed Ash package.
    PackagedNode,
    /// The exact Electron host executable entered into Node mode for one child process.
    ElectronRunAsNode,
}

/// One frozen Node-compatible executable supplied by the Ash installation or product host.
///
/// The runtime never resolves `node` from the ambient `PATH`. Electron Desktop supplies its exact
/// executable through `ASH_ELECTRON_RUN_AS_NODE_PATH`; other packaged hosts use the standalone
/// Node resource. Development hosts and tests may inject either exact executable explicitly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedNodeRuntime {
    executable: PathBuf,
    source: ManagedNodeRuntimeSource,
}

impl ManagedNodeRuntime {
    /// Freezes one exact standalone Node executable after regular-file and executable validation.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, LanguageServerProviderError> {
        Ok(Self {
            executable: canonical_executable(path.as_ref(), "managed Node runtime")?,
            source: ManagedNodeRuntimeSource::PackagedNode,
        })
    }

    /// Freezes one exact Electron executable to be invoked in its supported Node mode.
    pub fn from_electron_path(path: impl AsRef<Path>) -> Result<Self, LanguageServerProviderError> {
        Ok(Self {
            executable: canonical_executable(path.as_ref(), "managed Electron Node runtime")?,
            source: ManagedNodeRuntimeSource::ElectronRunAsNode,
        })
    }

    /// Resolves the host-injected Electron runtime or the signed standalone Node resource.
    ///
    /// An Electron runtime declaration is authoritative: if it is invalid, resolution fails
    /// instead of silently switching to a different executable.
    pub fn from_install_context(
        context: &InstallContext,
    ) -> Result<Self, LanguageServerProviderError> {
        if let Some(executable) = env::var_os(ELECTRON_RUN_AS_NODE_PATH) {
            return Self::from_electron_path(executable);
        }
        let resource = PathBuf::from("node")
            .join("bin")
            .join(node_executable_name());
        let path = context
            .bundled_resource(&resource)
            .ok_or(LanguageServerProviderError::ManagedNodeUnavailable)?;
        Self::from_path(path)
    }

    /// Returns the frozen canonical Node executable.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Returns how the frozen executable enters a Node-compatible runtime.
    pub const fn source(&self) -> ManagedNodeRuntimeSource {
        self.source
    }

    pub(crate) fn command_for_script(
        &self,
        script: &Path,
        dir_root: &Path,
    ) -> Result<LanguageServerCommand, LanguageServerProviderError> {
        let script = canonical_regular_file(script, "language-server Node entrypoint")?;
        let mut command = LanguageServerCommand::new(self.executable.as_os_str())
            .with_clean_environment()
            .with_argument(script.into_os_string())
            .with_argument("--stdio")
            .with_current_dir(dir_root);
        for name in SAFE_NODE_ENVIRONMENT {
            if let Some(value) = env::var_os(name) {
                command = command.with_environment(name, value);
            }
        }
        if self.source == ManagedNodeRuntimeSource::ElectronRunAsNode {
            command = command.with_environment("ELECTRON_RUN_AS_NODE", "1");
        }
        Ok(command)
    }
}

#[cfg(windows)]
fn node_executable_name() -> &'static OsStr {
    OsStr::new("node.exe")
}

#[cfg(not(windows))]
fn node_executable_name() -> &'static OsStr {
    OsStr::new("node")
}
