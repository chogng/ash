//! Direct, injectable platform signing, verification, and notarization commands.

use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

/// One direct signing or verification tool invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningCommand {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
}

/// Complete command plan and expected outputs for one signed artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningPlan {
    pub input: PathBuf,
    pub artifact: PathBuf,
    pub auxiliary_artifacts: Vec<PathBuf>,
    pub commands: Vec<SigningCommand>,
}

/// Verified result of executing a signing plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningOutput {
    pub artifact: PathBuf,
    pub auxiliary_artifacts: Vec<PathBuf>,
}

/// macOS Developer ID Application identity used for hardened-runtime code signing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacOsApplicationSigning {
    identity: String,
}

impl MacOsApplicationSigning {
    pub fn new(identity: impl Into<String>) -> Result<Self, SigningConfigError> {
        Ok(Self {
            identity: nonempty(identity, "macOS application signing identity")?,
        })
    }
}

/// macOS Developer ID Installer identity and notarytool keychain profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacOsPackageSigning {
    identity: String,
    notary_profile: String,
}

impl MacOsPackageSigning {
    pub fn new(
        identity: impl Into<String>,
        notary_profile: impl Into<String>,
    ) -> Result<Self, SigningConfigError> {
        Ok(Self {
            identity: nonempty(identity, "macOS installer signing identity")?,
            notary_profile: nonempty(notary_profile, "macOS notary keychain profile")?,
        })
    }
}

/// Windows certificate-store SHA-1 thumbprint and RFC 3161 timestamp endpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowsSigning {
    certificate_sha1: String,
    timestamp_url: String,
}

impl WindowsSigning {
    pub fn new(
        certificate_sha1: impl Into<String>,
        timestamp_url: impl Into<String>,
    ) -> Result<Self, SigningConfigError> {
        let certificate_sha1 = nonempty(certificate_sha1, "Windows certificate thumbprint")?
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect::<String>();
        if certificate_sha1.len() != 40
            || !certificate_sha1
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(SigningConfigError::message(
                "Windows certificate thumbprint must contain exactly 40 hexadecimal digits",
            ));
        }
        let timestamp_url = nonempty(timestamp_url, "Windows timestamp URL")?;
        let parsed_timestamp = url::Url::parse(&timestamp_url).map_err(|_| {
            SigningConfigError::message("Windows timestamp URL must be an absolute HTTPS URL")
        })?;
        if parsed_timestamp.scheme() != "https" || parsed_timestamp.host_str().is_none() {
            return Err(SigningConfigError::message(
                "Windows timestamp URL must be an absolute HTTPS URL",
            ));
        }
        Ok(Self {
            certificate_sha1: certificate_sha1.to_ascii_uppercase(),
            timestamp_url,
        })
    }
}

/// GnuPG key identity used to produce a detached armored AppImage signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinuxSigning {
    key_id: String,
}

impl LinuxSigning {
    pub fn new(key_id: impl Into<String>) -> Result<Self, SigningConfigError> {
        Ok(Self {
            key_id: nonempty(key_id, "Linux signing key identity")?,
        })
    }
}

/// Invalid release signing configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningConfigError(String);

impl SigningConfigError {
    fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for SigningConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for SigningConfigError {}

/// Injectable owner of codesign, notarytool, SignTool, and GnuPG execution.
pub trait SigningTool: Send + Sync {
    fn run(&self, command: &SigningCommand) -> Result<(), SigningToolError>;
}

/// Direct operating-system process implementation of [`SigningTool`].
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemSigningTool;

impl SigningTool for SystemSigningTool {
    fn run(&self, command: &SigningCommand) -> Result<(), SigningToolError> {
        let status = std::process::Command::new(&command.program)
            .args(&command.arguments)
            .status()
            .map_err(SigningToolError::source)?;
        if !status.success() {
            return Err(SigningToolError::message(format!(
                "signing tool exited with {status}"
            )));
        }
        Ok(())
    }
}

/// Failure returned by a signing tool backend.
#[derive(Debug)]
pub struct SigningToolError(Box<dyn Error + Send + Sync>);

impl SigningToolError {
    pub fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for SigningToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "signing tool failed: {}", self.0)
    }
}

impl Error for SigningToolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Invalid input, tool failure, or missing declared output during signing.
#[derive(Debug)]
pub struct SigningError(Box<dyn Error + Send + Sync>);

impl SigningError {
    fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for SigningError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "artifact signing failed: {}", self.0)
    }
}

impl Error for SigningError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Stateless signing planner and fail-closed executor.
#[derive(Clone, Copy, Debug, Default)]
pub struct ArtifactSigner;

impl ArtifactSigner {
    /// Prepares hardened-runtime signing and strict verification for a macOS application bundle.
    pub fn macos_application(
        bundle: impl Into<PathBuf>,
        config: &MacOsApplicationSigning,
    ) -> SigningPlan {
        let bundle = bundle.into();
        SigningPlan {
            input: bundle.clone(),
            artifact: bundle.clone(),
            auxiliary_artifacts: Vec::new(),
            commands: vec![
                command(
                    "/usr/bin/codesign",
                    [
                        "--force".into(),
                        "--options".into(),
                        "runtime".into(),
                        "--timestamp".into(),
                        "--sign".into(),
                        config.identity.clone().into(),
                        bundle.as_os_str().to_owned(),
                    ],
                ),
                command(
                    "/usr/bin/codesign",
                    [
                        "--verify".into(),
                        "--deep".into(),
                        "--strict".into(),
                        "--verbose=2".into(),
                        bundle.as_os_str().to_owned(),
                    ],
                ),
            ],
        }
    }

    /// Prepares installer signing, notarization, ticket stapling, and Gatekeeper assessment.
    pub fn macos_package(
        package: impl Into<PathBuf>,
        config: &MacOsPackageSigning,
    ) -> Result<SigningPlan, SigningError> {
        let package = package.into();
        let signed = suffixed_path(&package, "-signed", "pkg")?;
        Ok(SigningPlan {
            input: package.clone(),
            artifact: signed.clone(),
            auxiliary_artifacts: Vec::new(),
            commands: vec![
                command(
                    "/usr/bin/productsign",
                    [
                        "--sign".into(),
                        config.identity.clone().into(),
                        package.as_os_str().to_owned(),
                        signed.as_os_str().to_owned(),
                    ],
                ),
                command(
                    "/usr/sbin/pkgutil",
                    ["--check-signature".into(), signed.as_os_str().to_owned()],
                ),
                command(
                    "/usr/bin/xcrun",
                    [
                        "notarytool".into(),
                        "submit".into(),
                        signed.as_os_str().to_owned(),
                        "--keychain-profile".into(),
                        config.notary_profile.clone().into(),
                        "--wait".into(),
                    ],
                ),
                command(
                    "/usr/bin/xcrun",
                    [
                        "stapler".into(),
                        "staple".into(),
                        signed.as_os_str().to_owned(),
                    ],
                ),
                command(
                    "/usr/sbin/spctl",
                    [
                        "--assess".into(),
                        "--type".into(),
                        "install".into(),
                        "--verbose=2".into(),
                        signed.as_os_str().to_owned(),
                    ],
                ),
            ],
        })
    }

    /// Prepares Authenticode SHA-256 signing, RFC 3161 timestamping, and policy verification.
    pub fn windows(artifact: impl Into<PathBuf>, config: &WindowsSigning) -> SigningPlan {
        let artifact = artifact.into();
        SigningPlan {
            input: artifact.clone(),
            artifact: artifact.clone(),
            auxiliary_artifacts: Vec::new(),
            commands: vec![
                command(
                    "signtool",
                    [
                        "sign".into(),
                        "/sha1".into(),
                        config.certificate_sha1.clone().into(),
                        "/fd".into(),
                        "SHA256".into(),
                        "/tr".into(),
                        config.timestamp_url.clone().into(),
                        "/td".into(),
                        "SHA256".into(),
                        artifact.as_os_str().to_owned(),
                    ],
                ),
                command(
                    "signtool",
                    [
                        "verify".into(),
                        "/pa".into(),
                        "/v".into(),
                        artifact.as_os_str().to_owned(),
                    ],
                ),
            ],
        }
    }

    /// Prepares a detached armored GnuPG signature and immediate verification for an AppImage.
    pub fn linux_appimage(
        appimage: impl Into<PathBuf>,
        config: &LinuxSigning,
    ) -> Result<SigningPlan, SigningError> {
        let appimage = appimage.into();
        let signature = suffixed_path(&appimage, "", "AppImage.asc")?;
        Ok(SigningPlan {
            input: appimage.clone(),
            artifact: appimage.clone(),
            auxiliary_artifacts: vec![signature.clone()],
            commands: vec![
                command(
                    "gpg",
                    [
                        "--batch".into(),
                        "--yes".into(),
                        "--armor".into(),
                        "--detach-sign".into(),
                        "--local-user".into(),
                        config.key_id.clone().into(),
                        "--output".into(),
                        signature.as_os_str().to_owned(),
                        appimage.as_os_str().to_owned(),
                    ],
                ),
                command(
                    "gpg",
                    [
                        "--batch".into(),
                        "--verify".into(),
                        signature.as_os_str().to_owned(),
                        appimage.as_os_str().to_owned(),
                    ],
                ),
            ],
        })
    }

    /// Executes every command in order and verifies all declared outputs.
    pub fn execute(
        plan: SigningPlan,
        tool: &dyn SigningTool,
    ) -> Result<SigningOutput, SigningError> {
        validate_input(&plan.input)?;
        if plan.artifact != plan.input && plan.artifact.exists() {
            return Err(SigningError::message(
                "signed artifact already exists; refusing to overwrite it",
            ));
        }
        for auxiliary in &plan.auxiliary_artifacts {
            if auxiliary.exists() {
                return Err(SigningError::message(
                    "signature output already exists; refusing to overwrite it",
                ));
            }
        }
        for command in &plan.commands {
            tool.run(command).map_err(SigningError::source)?;
        }
        validate_output(&plan.artifact)?;
        for auxiliary in &plan.auxiliary_artifacts {
            validate_output(auxiliary)?;
        }
        Ok(SigningOutput {
            artifact: plan.artifact,
            auxiliary_artifacts: plan.auxiliary_artifacts,
        })
    }
}

fn command(
    program: impl Into<PathBuf>,
    arguments: impl IntoIterator<Item = OsString>,
) -> SigningCommand {
    SigningCommand {
        program: program.into(),
        arguments: arguments.into_iter().collect(),
    }
}

fn nonempty(value: impl Into<String>, description: &str) -> Result<String, SigningConfigError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(SigningConfigError::message(format!(
            "{description} cannot be empty"
        )));
    }
    Ok(value)
}

fn suffixed_path(path: &Path, suffix: &str, extension: &str) -> Result<PathBuf, SigningError> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| SigningError::message("artifact path needs a Unicode file stem"))?;
    Ok(path.with_file_name(format!("{stem}{suffix}.{extension}")))
}

fn validate_input(path: &Path) -> Result<(), SigningError> {
    let metadata = std::fs::symlink_metadata(path).map_err(SigningError::source)?;
    if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
        return Err(SigningError::message(
            "signing input must be a regular file or directory",
        ));
    }
    Ok(())
}

fn validate_output(path: &Path) -> Result<(), SigningError> {
    let metadata = std::fs::symlink_metadata(path).map_err(SigningError::source)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() && !metadata.is_dir() {
        return Err(SigningError::message(
            "signing tool did not create a regular declared output",
        ));
    }
    Ok(())
}
