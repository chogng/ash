//! Runtime description of the Ash installation and its managed resource locations.
//!
//! Package resources are returned as candidates for consumers to validate and probe.
//! SystemExecutables separately resolves automatic helpers within trusted installation roots.
//! Consumers retain execution authority for both kinds of resource.

mod system;

pub use system::SystemExecutables;

use std::env;
use std::ffi::OsString;
use std::fmt;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const PACKAGE_BIN_DIRECTORY: &str = "bin";
const PACKAGE_PATH_DIRECTORY: &str = "ash-path";
const PACKAGE_RESOURCES_DIRECTORY: &str = "ash-resources";
const PACKAGE_METADATA_FILE: &str = "ash-package.json";
const TGREP_OVERRIDE: &str = "ASH_TGREP_PATH";
const RIPGREP_OVERRIDE: &str = "ASH_RG_PATH";
const BUBBLEWRAP_OVERRIDE: &str = "ASH_BWRAP_PATH";
const WINDOWS_SANDBOX_OVERRIDE: &str = "ASH_WINDOWS_SANDBOX_BIN";

/// Installation shape detected for the running Ash executable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallMethod {
    /// A package root containing `bin/` and at least one managed resource directory.
    Package,
    /// A development build, custom launcher, or otherwise unrecognized layout.
    Other,
}

/// Directories owned by one packaged Ash distribution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageLayout {
    package_directory: PathBuf,
    metadata_file: PathBuf,
    binary_directory: PathBuf,
    path_directory: PathBuf,
    resources_directory: PathBuf,
}

impl PackageLayout {
    pub fn package_directory(&self) -> &Path {
        &self.package_directory
    }

    pub fn metadata_file(&self) -> &Path {
        &self.metadata_file
    }

    pub fn binary_directory(&self) -> &Path {
        &self.binary_directory
    }

    pub fn path_directory(&self) -> &Path {
        &self.path_directory
    }

    pub fn resources_directory(&self) -> &Path {
        &self.resources_directory
    }
}

/// Managed executable identities whose installation candidates Ash can locate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedExecutable {
    Ripgrep,
    Tgrep,
    Bubblewrap,
    WindowsSandbox,
}

/// One explicit environment override that must not silently fall back when invalid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutableOverride {
    variable: &'static str,
    path: PathBuf,
}

impl ExecutableOverride {
    pub fn variable(&self) -> &'static str {
        self.variable
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Mutually exclusive resolution paths for one managed executable.
///
/// An explicit override is authoritative and therefore never exposes fallback paths. Without an
/// override, consumers may try [`Self::SearchPaths`] in order and skip invalid candidates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutableCandidates {
    ExplicitOverride(ExecutableOverride),
    SearchPaths(Vec<PathBuf>),
}

/// Validated executable basename used to query the frozen host `PATH` snapshot.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct HostExecutableName(String);

impl HostExecutableName {
    pub fn new(name: impl Into<String>) -> Result<Self, InvalidHostExecutableName> {
        let name = name.into();
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\\')
            || name.contains('\0')
            || (cfg!(windows) && name.contains(':'))
        {
            return Err(InvalidHostExecutableName(name));
        }
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Failure to construct a host executable name from a path or empty value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidHostExecutableName(String);

impl fmt::Display for InvalidHostExecutableName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid host executable name `{}`", self.0)
    }
}

impl std::error::Error for InvalidHostExecutableName {}

/// Immutable snapshot of the running Ash installation and executable search environment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallContext {
    method: InstallMethod,
    package_layout: Option<PackageLayout>,
    executable_directory: Option<PathBuf>,
    ripgrep_override: Option<OsString>,
    tgrep_override: Option<OsString>,
    bubblewrap_override: Option<OsString>,
    windows_sandbox_override: Option<OsString>,
    search_path: Option<OsString>,
}

impl InstallContext {
    /// Detects the current executable, package layout, and relevant environment overrides once.
    pub fn current() -> Self {
        static CURRENT: OnceLock<InstallContext> = OnceLock::new();
        CURRENT
            .get_or_init(|| {
                let executable = env::current_exe()
                    .ok()
                    .and_then(|path| dunce::canonicalize(path).ok());
                let mut context = Self::detect(
                    executable.as_deref(),
                    env::var_os(RIPGREP_OVERRIDE),
                    env::var_os(BUBBLEWRAP_OVERRIDE),
                    env::var_os("PATH"),
                );
                context.tgrep_override = env::var_os(TGREP_OVERRIDE);
                context.windows_sandbox_override = env::var_os(WINDOWS_SANDBOX_OVERRIDE);
                context
            })
            .clone()
    }

    pub fn method(&self) -> InstallMethod {
        self.method
    }

    pub fn package_layout(&self) -> Option<&PackageLayout> {
        self.package_layout.as_ref()
    }

    /// Returns an existing file candidate below `ash-resources/`, when this is a package install.
    pub fn bundled_resource(&self, name: impl AsRef<Path>) -> Option<PathBuf> {
        let name = name.as_ref();
        if !is_safe_resource_name(name) {
            return None;
        }
        let candidate =
            path_utils::join_descendant(&self.package_layout.as_ref()?.resources_directory, name)
                .ok()?;
        candidate.is_file().then_some(candidate)
    }

    /// Returns an existing directory candidate below `ash-resources/`.
    ///
    /// Consumers remain responsible for validating the directory tree and must not treat package
    /// provenance as content trust or execution authority.
    pub fn bundled_resource_directory(&self, name: impl AsRef<Path>) -> Option<PathBuf> {
        let name = name.as_ref();
        if !is_safe_resource_name(name) {
            return None;
        }
        let candidate =
            path_utils::join_descendant(&self.package_layout.as_ref()?.resources_directory, name)
                .ok()?;
        candidate.is_dir().then_some(candidate)
    }

    /// Produces a frozen, precedence-ordered snapshot of installation candidates.
    pub fn executable_candidates(&self, executable: ManagedExecutable) -> ExecutableCandidates {
        let (override_variable, explicit_override) = match executable {
            ManagedExecutable::Ripgrep => (RIPGREP_OVERRIDE, self.ripgrep_override.as_ref()),
            ManagedExecutable::Tgrep => (TGREP_OVERRIDE, self.tgrep_override.as_ref()),
            ManagedExecutable::Bubblewrap => {
                (BUBBLEWRAP_OVERRIDE, self.bubblewrap_override.as_ref())
            }
            ManagedExecutable::WindowsSandbox => (
                WINDOWS_SANDBOX_OVERRIDE,
                self.windows_sandbox_override.as_ref(),
            ),
        };
        if let Some(path) = explicit_override {
            return ExecutableCandidates::ExplicitOverride(ExecutableOverride {
                variable: override_variable,
                path: PathBuf::from(path),
            });
        }
        if executable == ManagedExecutable::Tgrep {
            return ExecutableCandidates::SearchPaths(
                self.package_layout
                    .as_ref()
                    .map(|layout| {
                        layout
                            .resources_directory
                            .join("tgrep")
                            .join(if cfg!(windows) { "tgrep.exe" } else { "tgrep" })
                    })
                    .into_iter()
                    .collect(),
            );
        }
        let mut paths = Vec::new();
        if let Some(layout) = &self.package_layout {
            let directory = match executable {
                ManagedExecutable::Ripgrep => &layout.path_directory,
                ManagedExecutable::Tgrep => unreachable!("handled as a packaged resource"),
                ManagedExecutable::Bubblewrap => &layout.resources_directory,
                ManagedExecutable::WindowsSandbox => &layout.binary_directory,
            };
            push_executable_candidates(&mut paths, directory, executable);
        }
        if matches!(
            executable,
            ManagedExecutable::Ripgrep | ManagedExecutable::WindowsSandbox
        ) && let Some(directory) = &self.executable_directory
        {
            push_executable_candidates(&mut paths, directory, executable);
        }
        if !matches!(executable, ManagedExecutable::WindowsSandbox)
            && let Some(search_path) = &self.search_path
        {
            for directory in env::split_paths(search_path) {
                push_executable_candidates(&mut paths, &directory, executable);
            }
        }
        ExecutableCandidates::SearchPaths(paths)
    }

    /// Produces candidates for a consumer-owned executable identity from the frozen host `PATH`.
    ///
    /// This method does not inspect, canonicalize, trust, probe, or execute the candidates. Those
    /// obligations remain with the domain that owns the requested executable.
    pub fn host_path_candidates(&self, executable: &HostExecutableName) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let Some(search_path) = &self.search_path else {
            return candidates;
        };
        for directory in env::split_paths(search_path) {
            push_host_executable_candidates(&mut candidates, &directory, executable);
        }
        candidates
    }

    fn detect(
        current_executable: Option<&Path>,
        ripgrep_override: Option<OsString>,
        bubblewrap_override: Option<OsString>,
        search_path: Option<OsString>,
    ) -> Self {
        let executable_directory = current_executable
            .and_then(Path::parent)
            .map(Path::to_path_buf);
        let package_layout = current_executable.and_then(detect_package_layout);
        let method = if package_layout.is_some() {
            InstallMethod::Package
        } else {
            InstallMethod::Other
        };
        Self {
            method,
            package_layout,
            executable_directory,
            ripgrep_override,
            tgrep_override: None,
            bubblewrap_override,
            windows_sandbox_override: None,
            search_path,
        }
    }
}

fn detect_package_layout(executable: &Path) -> Option<PackageLayout> {
    let binary_directory = executable.parent()?;
    if binary_directory.file_name()? != PACKAGE_BIN_DIRECTORY {
        return None;
    }
    let package_directory = binary_directory.parent()?;
    let metadata_file = package_directory.join(PACKAGE_METADATA_FILE);
    let path_directory = package_directory.join(PACKAGE_PATH_DIRECTORY);
    let resources_directory = package_directory.join(PACKAGE_RESOURCES_DIRECTORY);
    if !metadata_file.is_file() || !path_directory.is_dir() || !resources_directory.is_dir() {
        return None;
    }
    Some(PackageLayout {
        package_directory: package_directory.to_owned(),
        metadata_file,
        binary_directory: binary_directory.to_owned(),
        path_directory,
        resources_directory,
    })
}

fn is_safe_resource_name(name: &Path) -> bool {
    name.components()
        .any(|component| matches!(component, Component::Normal(_)))
}

fn push_executable_candidates(
    candidates: &mut Vec<PathBuf>,
    directory: &Path,
    executable: ManagedExecutable,
) {
    for name in executable_names(executable) {
        let candidate = directory.join(name);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
}

fn executable_names(executable: ManagedExecutable) -> &'static [&'static str] {
    match executable {
        ManagedExecutable::Ripgrep if cfg!(windows) => &["rg.exe", "rg"],
        ManagedExecutable::Ripgrep => &["rg"],
        ManagedExecutable::Bubblewrap => &["bwrap"],
        ManagedExecutable::Tgrep if cfg!(windows) => &["tgrep.exe"],
        ManagedExecutable::Tgrep => &["tgrep"],
        ManagedExecutable::WindowsSandbox => &["ash-windows-sandbox.exe"],
    }
}

fn push_host_executable_candidates(
    candidates: &mut Vec<PathBuf>,
    directory: &Path,
    executable: &HostExecutableName,
) {
    #[cfg(windows)]
    if Path::new(executable.as_str()).extension().is_none() {
        candidates.push(directory.join(format!("{}.exe", executable.as_str())));
    }
    let candidate = directory.join(executable.as_str());
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

#[cfg(test)]
#[path = "install_context_tests.rs"]
mod tests;

mod product_services;
pub use product_services::discovered_product_services_path;
