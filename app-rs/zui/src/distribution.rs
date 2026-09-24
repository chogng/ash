//! Deterministic application bundle staging and operating-system metadata generation.

use std::error::Error;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;

use crate::app::ProtocolScheme;
use crate::services::AppVersion;
use crate::services::ResourcePath;

mod copy;
mod installer;
mod linux;
mod macos;
mod signing;
mod windows;

pub use installer::InstallerBuilder;
pub use installer::InstallerCommand;
pub use installer::InstallerError;
pub use installer::InstallerOutput;
pub use installer::InstallerPlan;
pub use installer::InstallerTarget;
pub use installer::InstallerTool;
pub use installer::InstallerToolError;
pub use installer::SystemInstallerTool;
pub use signing::ArtifactSigner;
pub use signing::LinuxSigning;
pub use signing::MacOsApplicationSigning;
pub use signing::MacOsPackageSigning;
pub use signing::SigningCommand;
pub use signing::SigningConfigError;
pub use signing::SigningError;
pub use signing::SigningOutput;
pub use signing::SigningPlan;
pub use signing::SigningTool;
pub use signing::SigningToolError;
pub use signing::SystemSigningTool;
pub use signing::WindowsSigning;

/// Validated reverse-DNS application identifier.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AppIdentifier(String);

impl AppIdentifier {
    /// Creates an identifier such as `com.example.demo`.
    pub fn new(value: impl Into<String>) -> Result<Self, BundleManifestError> {
        let value = value.into();
        if value.split('.').count() < 2
            || value.split('.').any(|segment| {
                segment.is_empty()
                    || !segment
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
        {
            return Err(BundleManifestError::InvalidIdentifier);
        }
        Ok(Self(value))
    }

    /// Returns the stable reverse-DNS identifier.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One file or directory copied beneath the packaged resource root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleResource {
    pub source: PathBuf,
    pub destination: ResourcePath,
}

/// Cross-platform metadata and inputs needed to stage one native application bundle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleManifest {
    pub name: String,
    pub identifier: AppIdentifier,
    pub version: AppVersion,
    pub executable: PathBuf,
    pub icon: Option<PathBuf>,
    pub resources: Vec<BundleResource>,
    pub protocols: Vec<ProtocolScheme>,
    pub windows_appcontainer_runner: Option<PathBuf>,
}

impl BundleManifest {
    /// Creates a manifest with no icon, resources, or custom protocols.
    pub fn new(
        name: impl Into<String>,
        identifier: AppIdentifier,
        version: AppVersion,
        executable: impl Into<PathBuf>,
    ) -> Result<Self, BundleManifestError> {
        let name = name.into();
        validate_name(&name)?;
        Ok(Self {
            name,
            identifier,
            version,
            executable: executable.into(),
            icon: None,
            resources: Vec::new(),
            protocols: Vec::new(),
            windows_appcontainer_runner: None,
        })
    }

    /// Parses the stable JSON representation consumed by `zui-packager`.
    pub fn from_json(bytes: &[u8]) -> Result<Self, BundleManifestError> {
        let raw: RawBundleManifest = serde_json::from_slice(bytes)
            .map_err(|source| BundleManifestError::InvalidJson(source.to_string()))?;
        let mut manifest = Self::new(
            raw.name,
            AppIdentifier::new(raw.identifier)?,
            AppVersion::parse(raw.version)
                .map_err(|source| BundleManifestError::InvalidVersion(source.to_string()))?,
            raw.executable,
        )?;
        manifest.icon = raw.icon;
        for resource in raw.resources {
            manifest.resources.push(BundleResource {
                source: resource.source,
                destination: ResourcePath::new(resource.destination)
                    .map_err(|source| BundleManifestError::InvalidResource(source.to_string()))?,
            });
        }
        for protocol in raw.protocols {
            manifest.protocols.push(
                ProtocolScheme::new(protocol)
                    .map_err(|source| BundleManifestError::InvalidProtocol(source.to_string()))?,
            );
        }
        manifest.windows_appcontainer_runner = raw.windows_appcontainer_runner;
        Ok(manifest)
    }

    /// Resolves relative executable, icon, and resource inputs beneath a manifest directory.
    pub fn resolve_paths_from(mut self, directory: impl AsRef<Path>) -> Self {
        let directory = directory.as_ref();
        if self.executable.is_relative() {
            self.executable = directory.join(&self.executable);
        }
        if let Some(icon) = &mut self.icon
            && icon.is_relative()
        {
            *icon = directory.join(&*icon);
        }
        for resource in &mut self.resources {
            if resource.source.is_relative() {
                resource.source = directory.join(&resource.source);
            }
        }
        if let Some(runner) = &mut self.windows_appcontainer_runner
            && runner.is_relative()
        {
            *runner = directory.join(&*runner);
        }
        self
    }

    /// Sets platform icon artwork.
    pub fn with_icon(mut self, icon: impl Into<PathBuf>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    /// Adds one resource mapping.
    pub fn with_resource(mut self, resource: BundleResource) -> Self {
        self.resources.push(resource);
        self
    }

    /// Declares one custom URL protocol in generated platform metadata.
    pub fn with_protocol(mut self, protocol: ProtocolScheme) -> Self {
        if !self.protocols.contains(&protocol) {
            self.protocols.push(protocol);
        }
        self
    }

    /// Includes the helper required by the built-in Windows AppContainer process backend.
    pub fn with_windows_appcontainer_runner(mut self, runner: impl Into<PathBuf>) -> Self {
        self.windows_appcontainer_runner = Some(runner.into());
        self
    }
}

/// Native bundle layout generated by [`BundleBuilder`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BundleTarget {
    MacOsApplication,
    LinuxAppDir,
    WindowsPortable,
}

impl BundleTarget {
    /// Returns the layout matching the build host when the host is supported.
    pub const fn current() -> Option<Self> {
        #[cfg(target_os = "macos")]
        return Some(Self::MacOsApplication);
        #[cfg(target_os = "linux")]
        return Some(Self::LinuxAppDir);
        #[cfg(target_os = "windows")]
        return Some(Self::WindowsPortable);
        #[allow(unreachable_code)]
        None
    }
}

/// Successfully staged bundle and its generated protocol metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleOutput {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub protocol_manifest: PathBuf,
    pub helpers: Vec<PathBuf>,
}

/// Stateless deterministic bundle generator.
#[derive(Clone, Copy, Debug, Default)]
pub struct BundleBuilder;

impl BundleBuilder {
    /// Creates a new bundle beneath `output_directory` without overwriting existing paths.
    pub fn build(
        manifest: &BundleManifest,
        target: BundleTarget,
        output_directory: impl AsRef<Path>,
    ) -> Result<BundleOutput, BundleError> {
        validate_inputs(manifest)?;
        match target {
            BundleTarget::MacOsApplication => macos::build(manifest, output_directory.as_ref()),
            BundleTarget::LinuxAppDir => linux::build(manifest, output_directory.as_ref()),
            BundleTarget::WindowsPortable => windows::build(manifest, output_directory.as_ref()),
        }
    }
}

/// Invalid stable bundle manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BundleManifestError {
    InvalidName,
    InvalidIdentifier,
    InvalidJson(String),
    InvalidVersion(String),
    InvalidResource(String),
    InvalidProtocol(String),
}

impl fmt::Display for BundleManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => formatter.write_str("bundle name must be a safe file name"),
            Self::InvalidIdentifier => {
                formatter.write_str("bundle identifier must use reverse-DNS segments")
            }
            Self::InvalidJson(message) => write!(formatter, "invalid bundle JSON: {message}"),
            Self::InvalidVersion(message) => write!(formatter, "invalid bundle version: {message}"),
            Self::InvalidResource(message) => write!(formatter, "invalid resource: {message}"),
            Self::InvalidProtocol(message) => write!(formatter, "invalid protocol: {message}"),
        }
    }
}

impl Error for BundleManifestError {}

/// File-system failure while staging a bundle.
#[derive(Debug)]
pub struct BundleError(Box<dyn Error + Send + Sync>);

impl BundleError {
    pub(crate) fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    pub(crate) fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for BundleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "application bundle generation failed: {}",
            self.0
        )
    }
}

impl Error for BundleError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBundleManifest {
    name: String,
    identifier: String,
    version: String,
    executable: PathBuf,
    icon: Option<PathBuf>,
    #[serde(default)]
    resources: Vec<RawBundleResource>,
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    windows_appcontainer_runner: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBundleResource {
    source: PathBuf,
    destination: PathBuf,
}

fn validate_name(name: &str) -> Result<(), BundleManifestError> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(char::is_control)
        || name.contains(['/', '\\', '\0'])
        || name.contains(std::path::MAIN_SEPARATOR)
    {
        return Err(BundleManifestError::InvalidName);
    }
    Ok(())
}

fn validate_inputs(manifest: &BundleManifest) -> Result<(), BundleError> {
    if !manifest.executable.is_file() {
        return Err(BundleError::message("configured executable is not a file"));
    }
    if manifest.icon.as_ref().is_some_and(|icon| !icon.is_file()) {
        return Err(BundleError::message("configured icon is not a file"));
    }
    if manifest
        .windows_appcontainer_runner
        .as_ref()
        .is_some_and(|runner| !runner.is_file())
    {
        return Err(BundleError::message(
            "configured Windows AppContainer runner is not a file",
        ));
    }
    for resource in &manifest.resources {
        if !resource.source.exists() {
            return Err(BundleError::message("configured resource does not exist"));
        }
    }
    Ok(())
}

pub(crate) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
#[path = "distribution/tests.rs"]
mod tests;
