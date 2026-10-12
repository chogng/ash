use std::env;
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use ash_install_context::InstallContext;
use ash_lsp::LanguageServerCommand;
use sha2::Digest;
use sha2::Sha256;

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
    electron_digest: Option<String>,
}

impl ManagedNodeRuntime {
    /// Freezes one exact standalone Node executable after regular-file and executable validation.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, LanguageServerProviderError> {
        Ok(Self {
            executable: canonical_executable(path.as_ref(), "managed Node runtime")?,
            source: ManagedNodeRuntimeSource::PackagedNode,
            electron_digest: None,
        })
    }

    /// Freezes one exact Electron executable to be invoked in its supported Node mode.
    pub fn from_electron_path(path: impl AsRef<Path>) -> Result<Self, LanguageServerProviderError> {
        let executable = canonical_executable(path.as_ref(), "managed Electron Node runtime")?;
        let electron_digest = Some(runtime_digest(&executable)?);
        Ok(Self {
            executable,
            source: ManagedNodeRuntimeSource::ElectronRunAsNode,
            electron_digest,
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
            match env::var("ASH_ELECTRON_RUNTIME_AVAILABLE").as_deref() {
                Ok("1") | Err(env::VarError::NotPresent) => {}
                Ok(_) | Err(_) => return Err(LanguageServerProviderError::ManagedNodeUnavailable),
            }
            let runtime = Self::from_electron_path(executable)?;
            if let Some(expected) = env::var_os("ASH_ELECTRON_RUN_AS_NODE_SHA256")
                && expected.to_str() != runtime.electron_digest.as_deref()
            {
                return Err(LanguageServerProviderError::ManagedNodeUnavailable);
            }
            return Ok(runtime);
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
        if let Some(expected) = &self.electron_digest
            && &runtime_digest(&self.executable)? != expected
        {
            return Err(LanguageServerProviderError::ManagedNodeUnavailable);
        }
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

fn runtime_digest(path: &Path) -> Result<String, LanguageServerProviderError> {
    let mut file =
        File::open(path).map_err(|_| LanguageServerProviderError::ManagedNodeUnavailable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| LanguageServerProviderError::ManagedNodeUnavailable)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(windows)]
fn node_executable_name() -> &'static OsStr {
    OsStr::new("node.exe")
}

#[cfg(not(windows))]
fn node_executable_name() -> &'static OsStr {
    OsStr::new("node")
}
