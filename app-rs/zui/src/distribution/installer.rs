//! Explicit, injectable execution of native installer toolchains.

use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use super::BundleManifest;
use super::BundleOutput;

mod windows;

/// Native installer format produced from a staged application bundle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallerTarget {
    MacOsPackage,
    LinuxAppImage,
    WindowsMsi,
}

impl InstallerTarget {
    /// Returns the installer format matching the build host when the host is supported.
    pub const fn current() -> Option<Self> {
        #[cfg(target_os = "macos")]
        return Some(Self::MacOsPackage);
        #[cfg(target_os = "linux")]
        return Some(Self::LinuxAppImage);
        #[cfg(target_os = "windows")]
        return Some(Self::WindowsMsi);
        #[allow(unreachable_code)]
        None
    }
}

/// One direct executable invocation; arguments are never parsed by a shell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerCommand {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
}

/// Prepared installer inputs and the tool invocation needed to produce the artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerPlan {
    pub target: InstallerTarget,
    pub artifact: PathBuf,
    pub definition: Option<PathBuf>,
    pub command: InstallerCommand,
}

/// Completed native installer artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerOutput {
    pub artifact: PathBuf,
    pub definition: Option<PathBuf>,
}

/// Injectable owner of external packaging tools such as `pkgbuild`, `appimagetool`, and WiX.
pub trait InstallerTool: Send + Sync {
    fn run(&self, command: &InstallerCommand) -> Result<(), InstallerToolError>;
}

/// Direct operating-system process implementation of [`InstallerTool`].
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemInstallerTool;

impl InstallerTool for SystemInstallerTool {
    fn run(&self, command: &InstallerCommand) -> Result<(), InstallerToolError> {
        let status = std::process::Command::new(&command.program)
            .args(&command.arguments)
            .status()
            .map_err(InstallerToolError::source)?;
        if !status.success() {
            return Err(InstallerToolError::message(format!(
                "installer tool exited with {status}"
            )));
        }
        Ok(())
    }
}

/// Failure returned by an installer tool backend.
#[derive(Debug)]
pub struct InstallerToolError(Box<dyn Error + Send + Sync>);

impl InstallerToolError {
    /// Creates an error suitable for an injected tool implementation.
    pub fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for InstallerToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "installer tool failed: {}", self.0)
    }
}

impl Error for InstallerToolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Failure while validating, preparing, or executing an installer plan.
#[derive(Debug)]
pub struct InstallerError(Box<dyn Error + Send + Sync>);

impl InstallerError {
    pub(super) fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    pub(super) fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for InstallerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "installer generation failed: {}", self.0)
    }
}

impl Error for InstallerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Stateless native installer planner and executor.
#[derive(Clone, Copy, Debug, Default)]
pub struct InstallerBuilder;

impl InstallerBuilder {
    /// Validates a staged bundle and prepares an explicit platform tool invocation.
    pub fn prepare(
        manifest: &BundleManifest,
        bundle: &BundleOutput,
        target: InstallerTarget,
        output_directory: impl AsRef<Path>,
    ) -> Result<InstallerPlan, InstallerError> {
        validate_bundle(bundle)?;
        let output_directory = output_directory.as_ref();
        std::fs::create_dir_all(output_directory).map_err(InstallerError::source)?;
        let stem = format!("{}-{}", manifest.name, manifest.version);
        let artifact = match target {
            InstallerTarget::MacOsPackage => output_directory.join(format!("{stem}.pkg")),
            InstallerTarget::LinuxAppImage => output_directory.join(format!("{stem}.AppImage")),
            InstallerTarget::WindowsMsi => output_directory.join(format!("{stem}.msi")),
        };
        if artifact.exists() {
            return Err(InstallerError::message(
                "installer artifact already exists; refusing to overwrite it",
            ));
        }
        let (definition, command) = match target {
            InstallerTarget::MacOsPackage => {
                let command = InstallerCommand {
                    program: PathBuf::from("/usr/bin/pkgbuild"),
                    arguments: vec![
                        "--component".into(),
                        bundle.root.as_os_str().to_owned(),
                        "--install-location".into(),
                        "/Applications".into(),
                        "--identifier".into(),
                        manifest.identifier.as_str().into(),
                        "--version".into(),
                        manifest.version.platform_release().into(),
                        artifact.as_os_str().to_owned(),
                    ],
                };
                (None, command)
            }
            InstallerTarget::LinuxAppImage => {
                let command = InstallerCommand {
                    program: PathBuf::from("appimagetool"),
                    arguments: vec![
                        bundle.root.as_os_str().to_owned(),
                        artifact.as_os_str().to_owned(),
                    ],
                };
                (None, command)
            }
            InstallerTarget::WindowsMsi => {
                let definition = output_directory.join(format!("{stem}.wxs"));
                let source = windows::definition(manifest, bundle)?;
                write_new(&definition, source.as_bytes())?;
                let command = InstallerCommand {
                    program: PathBuf::from("wix"),
                    arguments: vec![
                        "build".into(),
                        definition.as_os_str().to_owned(),
                        "-o".into(),
                        artifact.as_os_str().to_owned(),
                    ],
                };
                (Some(definition), command)
            }
        };
        Ok(InstallerPlan {
            target,
            artifact,
            definition,
            command,
        })
    }

    /// Runs a prepared installer plan and verifies that the declared artifact was created.
    pub fn execute(
        plan: InstallerPlan,
        tool: &dyn InstallerTool,
    ) -> Result<InstallerOutput, InstallerError> {
        if plan.artifact.exists() {
            return Err(InstallerError::message(
                "installer artifact already exists; refusing to overwrite it",
            ));
        }
        tool.run(&plan.command).map_err(InstallerError::source)?;
        if !plan.artifact.is_file() {
            return Err(InstallerError::message(
                "installer tool succeeded without creating the declared artifact",
            ));
        }
        Ok(InstallerOutput {
            artifact: plan.artifact,
            definition: plan.definition,
        })
    }

    /// Prepares and executes one installer using the supplied tool backend.
    pub fn build(
        manifest: &BundleManifest,
        bundle: &BundleOutput,
        target: InstallerTarget,
        output_directory: impl AsRef<Path>,
        tool: &dyn InstallerTool,
    ) -> Result<InstallerOutput, InstallerError> {
        let plan = Self::prepare(manifest, bundle, target, output_directory)?;
        Self::execute(plan, tool)
    }
}

fn validate_bundle(bundle: &BundleOutput) -> Result<(), InstallerError> {
    let metadata = std::fs::symlink_metadata(&bundle.root).map_err(InstallerError::source)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(InstallerError::message(
            "installer input must be a regular staged bundle directory",
        ));
    }
    let executable =
        std::fs::symlink_metadata(&bundle.executable).map_err(InstallerError::source)?;
    if executable.file_type().is_symlink() || !executable.is_file() {
        return Err(InstallerError::message(
            "staged bundle executable must be a regular file",
        ));
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), InstallerError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(InstallerError::source)?;
    file.write_all(bytes).map_err(InstallerError::source)?;
    file.sync_all().map_err(InstallerError::source)
}
