use std::fmt;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::num::NonZeroU16;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::thread;

use ash_remote::RemotePlatform;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;

mod artifact_validation;
mod progress;
mod protocol;

use artifact_validation::is_canonical_absolute_posix_path;
pub(crate) use artifact_validation::open_and_validate_artifact;
pub use progress::RemoteRuntimeInstallProgress;
use progress::upload_archive;
use protocol::INSTALL_ERROR_MARKER;
use protocol::PLATFORM_UNSUPPORTED_MARKER;
use protocol::parse_install_receipt;
pub(crate) use protocol::parse_remote_platform;
use protocol::remote_install_failure;
pub(crate) use protocol::remote_platform_probe_command;
pub(crate) use protocol::remote_runtime_install_command;

const DEFAULT_CONNECT_TIMEOUT_SECONDS: NonZeroU16 = NonZeroU16::new(10).expect("non-zero");
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

/// A release version used as one component of an immutable Remote runtime path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeVersion(String);

impl RemoteRuntimeVersion {
    /// Parses a release version without allowing path or shell syntax.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteRuntimeArtifactError> {
        let value = value.as_ref().trim();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')
            })
        {
            return Err(RemoteRuntimeArtifactError::InvalidVersion);
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the version exactly as it must appear in trusted package metadata.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Trusted size and digest metadata supplied by the host's release catalog.
///
/// The installer checks the compressed size and SHA-256 before upload, checks the declared
/// unpacked size while validating the archive, and asks the Remote host to check the compressed
/// size and SHA-256 again before extraction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeArtifactIntegrity {
    archive_size: NonZeroU64,
    unpacked_size: NonZeroU64,
    sha256: String,
}

impl RemoteRuntimeArtifactIntegrity {
    /// Creates exact integrity metadata from a trusted local release record.
    pub fn new(
        archive_size: NonZeroU64,
        unpacked_size: NonZeroU64,
        sha256: impl AsRef<str>,
    ) -> Result<Self, RemoteRuntimeArtifactError> {
        let sha256 = sha256.as_ref();
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(RemoteRuntimeArtifactError::InvalidSha256);
        }
        Ok(Self {
            archive_size,
            unpacked_size,
            sha256: sha256.to_owned(),
        })
    }

    /// Returns the exact compressed byte count from the trusted release record.
    pub const fn archive_size(&self) -> NonZeroU64 {
        self.archive_size
    }

    /// Returns the sum of regular-file payload sizes expected after extraction.
    pub const fn unpacked_size(&self) -> NonZeroU64 {
        self.unpacked_size
    }

    /// Returns the lowercase SHA-256 of the compressed artifact.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// One locally available, release-authorized canonical Ash package archive.
///
/// The archive must be a rootless `tar.gz` containing package layout version 2 with a packaged
/// Node runtime. Construction records trusted catalog metadata; [`SshRemoteRuntimeInstaller`]
/// performs all filesystem, digest, archive-shape, and package-metadata checks before upload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeArtifact {
    archive: PathBuf,
    version: RemoteRuntimeVersion,
    platform: RemotePlatform,
    integrity: RemoteRuntimeArtifactIntegrity,
}

impl RemoteRuntimeArtifact {
    /// Describes a trusted release artifact already present on the native host.
    pub fn new(
        archive: impl Into<PathBuf>,
        version: RemoteRuntimeVersion,
        platform: RemotePlatform,
        integrity: RemoteRuntimeArtifactIntegrity,
    ) -> Self {
        Self {
            archive: archive.into(),
            version,
            platform,
            integrity,
        }
    }

    /// Returns the local archive selected by the trusted product coordinator.
    pub fn archive(&self) -> &Path {
        &self.archive
    }

    /// Returns the release version checked against `ash-package.json`.
    pub const fn version(&self) -> &RemoteRuntimeVersion {
        &self.version
    }

    /// Returns the exact target checked against the probed Remote platform and package metadata.
    pub const fn platform(&self) -> RemotePlatform {
        self.platform
    }

    /// Returns the trusted release integrity metadata.
    pub const fn integrity(&self) -> &RemoteRuntimeArtifactIntegrity {
        &self.integrity
    }
}

/// A canonical absolute POSIX root selected for Remote runtime objects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeInstallRoot(String);

impl RemoteRuntimeInstallRoot {
    /// Parses a canonical absolute POSIX path without shell control characters.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteRuntimeArtifactError> {
        let value = value.as_ref().trim();
        if !is_canonical_absolute_posix_path(value) {
            return Err(RemoteRuntimeArtifactError::InvalidInstallRoot);
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the path used only as a quoted value in the remote installation script.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// How a host chooses the root for immutable Remote runtime objects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeInstallLocation {
    /// Uses `$XDG_DATA_HOME/ash/remote` or `$HOME/.local/share/ash/remote` on the Remote host.
    UserData,
    /// Uses an explicit absolute path selected by a trusted product coordinator.
    Absolute(RemoteRuntimeInstallRoot),
}

/// Host-owned SSH installer for canonical Ash runtime packages.
///
/// The installer never downloads on the Remote host and never accepts credentials. OpenSSH
/// inherits the native host's config and agent. Successful installs are immutable, side by side,
/// and addressed by target, version, and archive digest; activation and rollback are performed by
/// selecting the returned [`RemoteRuntime`] in a product-owned `RemoteProfile`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshRemoteRuntimeInstaller {
    host: SshHost,
    ssh_executable: PathBuf,
    connect_timeout_seconds: NonZeroU16,
    location: RemoteRuntimeInstallLocation,
}

impl SshRemoteRuntimeInstaller {
    /// Creates an installer using the platform `ssh` command and Remote user data directory.
    pub fn new(host: SshHost) -> Self {
        Self {
            host,
            ssh_executable: PathBuf::from("ssh"),
            connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
            location: RemoteRuntimeInstallLocation::UserData,
        }
    }

    /// Selects the local OpenSSH executable controlled by the native product host.
    pub fn with_ssh_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.ssh_executable = executable.into();
        self
    }

    /// Selects the OpenSSH TCP connection timeout in whole seconds.
    pub fn with_connect_timeout_seconds(mut self, timeout: NonZeroU16) -> Self {
        self.connect_timeout_seconds = timeout;
        self
    }

    /// Selects an explicit Remote install root instead of the Remote user's data directory.
    pub fn with_install_root(mut self, root: RemoteRuntimeInstallRoot) -> Self {
        self.location = RemoteRuntimeInstallLocation::Absolute(root);
        self
    }

    /// Probes the exact package target before a product selects or uploads an artifact.
    pub fn probe_platform(&self) -> Result<RemotePlatform, RemoteRuntimeInstallError> {
        let output = Command::new(&self.ssh_executable)
            .args(self.ssh_arguments(remote_platform_probe_command()))
            .output()
            .map_err(|error| RemoteRuntimeInstallError::transport(error.to_string()))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(platform) = parse_remote_platform(&stdout) {
            return Ok(platform);
        }
        if let Some(diagnostic) = stdout
            .lines()
            .find_map(|line| line.strip_prefix(PLATFORM_UNSUPPORTED_MARKER))
        {
            return Err(RemoteRuntimeInstallError::new(
                RemoteRuntimeInstallFailureKind::UnsupportedPlatform,
                format!("unsupported Remote platform: {}", diagnostic.trim()),
            ));
        }
        let stderr = bounded_lossy(&output.stderr);
        Err(RemoteRuntimeInstallError::transport(if stderr.is_empty() {
            format!("Remote platform probe exited with {}", output.status)
        } else {
            format!("Remote platform probe failed: {stderr}")
        }))
    }

    /// Validates, uploads, verifies, and atomically installs one immutable runtime package.
    pub fn install(
        &self,
        artifact: &RemoteRuntimeArtifact,
    ) -> Result<RemoteInstalledRuntime, RemoteRuntimeInstallError> {
        self.install_with_progress(artifact, |_| {})
    }

    /// Installs one runtime while reporting stable host-side installation phases.
    ///
    /// Implementations call `report_progress` synchronously on the installing thread. Products
    /// should keep the callback non-blocking and project these events into their own UI or logs.
    pub fn install_with_progress(
        &self,
        artifact: &RemoteRuntimeArtifact,
        mut report_progress: impl FnMut(RemoteRuntimeInstallProgress),
    ) -> Result<RemoteInstalledRuntime, RemoteRuntimeInstallError> {
        report_progress(RemoteRuntimeInstallProgress::ValidatingArtifact);
        let mut archive = open_and_validate_artifact(artifact)?;
        report_progress(RemoteRuntimeInstallProgress::ProbingPlatform);
        let platform = self.probe_platform()?;
        if platform != artifact.platform {
            return Err(RemoteRuntimeInstallError::new(
                RemoteRuntimeInstallFailureKind::PlatformMismatch,
                format!(
                    "Remote host requires `{platform}`, but artifact targets `{}`",
                    artifact.platform
                ),
            ));
        }
        archive
            .seek(SeekFrom::Start(0))
            .map_err(RemoteRuntimeInstallError::artifact_unavailable)?;

        let remote_command = remote_runtime_install_command(artifact, &self.location);
        let mut child = Command::new(&self.ssh_executable)
            .args(self.ssh_arguments(remote_command))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| RemoteRuntimeInstallError::transport(error.to_string()))?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            RemoteRuntimeInstallError::transport("OpenSSH upload stdin was unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RemoteRuntimeInstallError::transport("OpenSSH install stdout was unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            RemoteRuntimeInstallError::transport("OpenSSH install stderr was unavailable")
        })?;
        let read_stdout = thread::spawn(move || read_bounded(stdout));
        let read_stderr = thread::spawn(move || read_bounded(stderr));
        let upload = upload_archive(
            &mut archive,
            &mut stdin,
            artifact.integrity.archive_size,
            &mut report_progress,
        )
        .map_err(|error| {
            RemoteRuntimeInstallError::transport(format!("runtime artifact upload: {error}"))
        });
        drop(stdin);
        report_progress(RemoteRuntimeInstallProgress::FinalizingRemoteInstall);
        let status = child
            .wait()
            .map_err(|error| RemoteRuntimeInstallError::transport(error.to_string()))?;
        let stdout = join_io(read_stdout, "Remote installer stdout")?;
        let stderr = join_io(read_stderr, "Remote installer stderr")?;

        let stdout = String::from_utf8_lossy(&stdout);
        if let Some(runtime) = parse_install_receipt(&stdout, artifact)? {
            if !status.success() {
                return Err(RemoteRuntimeInstallError::transport(format!(
                    "Remote installer reported success but OpenSSH exited with {status}"
                )));
            }
            if runtime.disposition == RemoteRuntimeInstallDisposition::Installed {
                let upload = upload?;
                if upload != artifact.integrity.archive_size.get() {
                    return Err(RemoteRuntimeInstallError::transport(format!(
                        "OpenSSH accepted {upload} of {} runtime artifact bytes",
                        artifact.integrity.archive_size
                    )));
                }
            }
            report_progress(RemoteRuntimeInstallProgress::Complete {
                disposition: runtime.disposition,
            });
            return Ok(runtime);
        }
        if let Some(code) = stdout
            .lines()
            .find_map(|line| line.strip_prefix(INSTALL_ERROR_MARKER))
            .map(str::trim)
        {
            return Err(remote_install_failure(code));
        }
        upload?;
        let stderr = bounded_lossy(&stderr);
        if status.code() == Some(255) {
            return Err(RemoteRuntimeInstallError::transport(if stderr.is_empty() {
                "OpenSSH transport failed during Remote runtime installation".into()
            } else {
                stderr
            }));
        }
        Err(RemoteRuntimeInstallError::new(
            RemoteRuntimeInstallFailureKind::RemoteRejected,
            if stderr.is_empty() {
                format!("Remote installer exited with {status} without a receipt")
            } else {
                format!("Remote installer failed: {stderr}")
            },
        ))
    }

    fn ssh_arguments(&self, remote_command: impl Into<String>) -> Vec<String> {
        vec![
            "-T".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            format!("ConnectTimeout={}", self.connect_timeout_seconds),
            self.host.as_str().into(),
            remote_command.into(),
        ]
    }
}

/// One exact runtime object successfully installed on the Remote host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteInstalledRuntime {
    runtime: RemoteRuntime,
    version: RemoteRuntimeVersion,
    platform: RemotePlatform,
    archive_sha256: String,
    disposition: RemoteRuntimeInstallDisposition,
}

impl RemoteInstalledRuntime {
    /// Returns the exact executable that a product should store in its `RemoteProfile`.
    pub const fn runtime(&self) -> &RemoteRuntime {
        &self.runtime
    }

    /// Returns the installed release version.
    pub const fn version(&self) -> &RemoteRuntimeVersion {
        &self.version
    }

    /// Returns the installed package target.
    pub const fn platform(&self) -> RemotePlatform {
        self.platform
    }

    /// Returns the content identity used by the immutable installation path.
    pub fn archive_sha256(&self) -> &str {
        &self.archive_sha256
    }

    /// Returns whether this call committed new bytes or reused an identical ready object.
    pub const fn disposition(&self) -> RemoteRuntimeInstallDisposition {
        self.disposition
    }

    /// Consumes the receipt and returns the exact executable for profile activation or rollback.
    pub fn into_runtime(self) -> RemoteRuntime {
        self.runtime
    }
}

/// The content-addressed result of one successful install request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeInstallDisposition {
    Installed,
    Reused,
}

/// Invalid trusted metadata supplied before any Remote process is started.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeArtifactError {
    InvalidVersion,
    InvalidSha256,
    InvalidInstallRoot,
}

impl fmt::Display for RemoteRuntimeArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersion => formatter.write_str("Remote runtime version is invalid"),
            Self::InvalidSha256 => {
                formatter.write_str("Remote runtime SHA-256 must be 64 lowercase hex characters")
            }
            Self::InvalidInstallRoot => formatter
                .write_str("Remote runtime install root must be a canonical absolute POSIX path"),
        }
    }
}

impl std::error::Error for RemoteRuntimeArtifactError {}

/// Stable recovery categories for Remote platform probing and runtime installation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeInstallFailureKind {
    Transport,
    UnsupportedPlatform,
    ArtifactUnavailable,
    ArtifactIntegrity,
    PlatformMismatch,
    RemotePrerequisite,
    ConcurrentInstall,
    RemoteRejected,
}

/// A classified failure before or during one Remote runtime installation.
#[derive(Debug)]
pub struct RemoteRuntimeInstallError {
    kind: RemoteRuntimeInstallFailureKind,
    message: String,
}

impl RemoteRuntimeInstallError {
    fn new(kind: RemoteRuntimeInstallFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self::new(RemoteRuntimeInstallFailureKind::Transport, message)
    }

    fn artifact_unavailable(error: io::Error) -> Self {
        Self::new(
            RemoteRuntimeInstallFailureKind::ArtifactUnavailable,
            error.to_string(),
        )
    }

    fn artifact_integrity(message: impl Into<String>) -> Self {
        Self::new(RemoteRuntimeInstallFailureKind::ArtifactIntegrity, message)
    }

    /// Returns the stable category a product should use for retry, artifact repair, or UX.
    pub const fn kind(&self) -> RemoteRuntimeInstallFailureKind {
        self.kind
    }

    /// Returns the diagnostic without the user-facing error prefix.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RemoteRuntimeInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "could not install the Remote runtime: {}",
            self.message
        )
    }
}

impl std::error::Error for RemoteRuntimeInstallError {}

fn read_bounded(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(output)
}

fn join_io<T>(
    handle: thread::JoinHandle<io::Result<T>>,
    operation: &str,
) -> Result<T, RemoteRuntimeInstallError> {
    handle
        .join()
        .map_err(|_| RemoteRuntimeInstallError::transport(format!("{operation} panicked")))?
        .map_err(|error| RemoteRuntimeInstallError::transport(format!("{operation}: {error}")))
}

fn bounded_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DIAGNOSTIC_BYTES)])
        .trim()
        .to_owned()
}
