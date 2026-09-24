use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use sha2::Digest;
use sha2::Sha256;

use super::ExternalUrl;
use super::SystemServiceError;
use super::blocking::BlockingServiceExecutor;

const UPDATE_SERVICE: &str = "application update";

/// Owned asynchronous result of signed application-update work.
pub type UpdateFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, SystemServiceError>> + Send + 'static>>;

/// Validated semantic application version.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct AppVersion(semver::Version);

impl AppVersion {
    /// Parses a semantic version without exposing the parser dependency.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, AppVersionError> {
        semver::Version::parse(value.as_ref())
            .map(Self)
            .map_err(|source| AppVersionError(source.to_string()))
    }

    pub(crate) fn platform_release(&self) -> String {
        format!("{}.{}.{}", self.0.major, self.0.minor, self.0.patch)
    }
}

impl fmt::Display for AppVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}

/// Invalid semantic application version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppVersionError(String);

impl fmt::Display for AppVersionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid application version: {}", self.0)
    }
}

impl Error for AppVersionError {}

/// Ed25519 public key trusted to sign update manifest payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdatePublicKey([u8; 32]);

impl UpdatePublicKey {
    /// Creates a key from its standard 32-byte representation.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Configuration for a signed HTTP update feed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateConfig {
    pub manifest_url: ExternalUrl,
    pub current_version: AppVersion,
    pub target: String,
    pub public_key: UpdatePublicKey,
    pub staging_directory: PathBuf,
    pub product: ash_product_update::UpdateProduct,
    pub policy: ash_product_update::UpdatePolicy,
    pub package_format: ash_product_update::PackageFormat,
}

impl UpdateConfig {
    /// Creates a configuration with an explicit build target and staging directory.
    pub fn new(
        manifest_url: ExternalUrl,
        current_version: AppVersion,
        target: impl Into<String>,
        public_key: UpdatePublicKey,
        staging_directory: impl Into<PathBuf>,
        product: ash_product_update::UpdateProduct,
        policy: ash_product_update::UpdatePolicy,
        package_format: ash_product_update::PackageFormat,
    ) -> Self {
        Self {
            manifest_url,
            current_version,
            target: target.into(),
            public_key,
            staging_directory: staging_directory.into(),
            product,
            policy,
            package_format,
        }
    }
}

/// Verified downloadable artifact selected for the current target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateArtifact {
    pub url: ExternalUrl,
    pub file_name: String,
    sha256: [u8; 32],
    size: u64,
}

/// Verified update newer than the configured application version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateRelease {
    pub version: AppVersion,
    pub artifact: UpdateArtifact,
}

/// Downloaded, hash-verified update ready for installer handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedUpdate {
    pub release: UpdateRelease,
    pub path: PathBuf,
}

/// Byte transport used for signed manifests and update artifacts.
pub trait UpdateTransport: Send + Sync {
    /// Downloads one complete resource.
    fn get(&self, url: &ExternalUrl) -> Result<Vec<u8>, SystemServiceError>;
}

/// Platform handoff used after an update has been fully verified.
pub trait UpdateInstaller: Send + Sync {
    /// Launches or opens a verified installer artifact.
    fn launch(&self, path: &Path) -> Result<(), SystemServiceError>;
}

/// Complete update backend exposed through [`UpdateHandle`].
pub trait UpdateService: Send + Sync {
    /// Checks the signed feed when invoked on ZUI's service worker pool.
    fn check(&self) -> Result<Option<UpdateRelease>, SystemServiceError>;

    /// Downloads and verifies one release into the configured staging directory.
    fn download(&self, release: UpdateRelease) -> Result<StagedUpdate, SystemServiceError>;

    /// Hands a verified artifact to the platform installer.
    fn install(&self, update: &StagedUpdate) -> Result<(), SystemServiceError>;
}

/// Default inert backend used until an application supplies a signed feed configuration.
#[derive(Clone, Copy, Debug, Default)]
pub struct DisabledUpdates;

impl UpdateService for DisabledUpdates {
    fn check(&self) -> Result<Option<UpdateRelease>, SystemServiceError> {
        Err(SystemServiceError::unsupported(UPDATE_SERVICE))
    }

    fn download(&self, _release: UpdateRelease) -> Result<StagedUpdate, SystemServiceError> {
        Err(SystemServiceError::unsupported(UPDATE_SERVICE))
    }

    fn install(&self, _update: &StagedUpdate) -> Result<(), SystemServiceError> {
        Err(SystemServiceError::unsupported(UPDATE_SERVICE))
    }
}

/// Cloneable application-wide signed update capability.
#[derive(Clone)]
pub struct UpdateHandle {
    service: Arc<dyn UpdateService>,
    executor: BlockingServiceExecutor,
}

impl UpdateHandle {
    pub(crate) fn new(service: impl UpdateService + 'static) -> Self {
        Self {
            service: Arc::new(service),
            executor: BlockingServiceExecutor,
        }
    }

    /// Checks the configured signed update feed without blocking the calling thread.
    pub fn check(&self) -> UpdateFuture<Option<UpdateRelease>> {
        let service = self.service.clone();
        self.executor.spawn(UPDATE_SERVICE, move || service.check())
    }

    /// Downloads and verifies one release without blocking the calling thread.
    pub fn download(&self, release: UpdateRelease) -> UpdateFuture<StagedUpdate> {
        let service = self.service.clone();
        self.executor
            .spawn(UPDATE_SERVICE, move || service.download(release))
    }

    /// Hands one verified update to the platform installer without blocking the calling thread.
    pub fn install(&self, update: StagedUpdate) -> UpdateFuture<()> {
        let service = self.service.clone();
        self.executor
            .spawn(UPDATE_SERVICE, move || service.install(&update))
    }
}

/// Blocking HTTP transport invoked on the service worker pool through [`UpdateHandle`].
#[derive(Clone, Copy, Debug, Default)]
pub struct HttpUpdateTransport;

impl UpdateTransport for HttpUpdateTransport {
    fn get(&self, url: &ExternalUrl) -> Result<Vec<u8>, SystemServiceError> {
        let response = ureq::get(url.as_str())
            .call()
            .map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))?;
        Ok(bytes)
    }
}

/// Default installer handoff that asks the operating system to open the verified artifact.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemUpdateInstaller;

impl UpdateInstaller for SystemUpdateInstaller {
    fn launch(&self, path: &Path) -> Result<(), SystemServiceError> {
        open::that(path).map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))
    }
}

/// Update backend that requires a strict Ed25519 manifest signature and artifact SHA-256.
pub struct SignedHttpUpdater {
    config: UpdateConfig,
    transport: Arc<dyn UpdateTransport>,
    installer: Arc<dyn UpdateInstaller>,
}

impl SignedHttpUpdater {
    /// Creates the default HTTP and system-installer implementation.
    pub fn new(config: UpdateConfig) -> Self {
        Self::with_backends(config, HttpUpdateTransport, SystemUpdateInstaller)
    }

    /// Injects deterministic transport and installer backends.
    pub fn with_backends(
        config: UpdateConfig,
        transport: impl UpdateTransport + 'static,
        installer: impl UpdateInstaller + 'static,
    ) -> Self {
        Self {
            config,
            transport: Arc::new(transport),
            installer: Arc::new(installer),
        }
    }

    fn parse_manifest(&self, bytes: &[u8]) -> Result<Option<UpdateRelease>, SystemServiceError> {
        let release = ash_product_update::verify_release(
            bytes,
            ash_product_update::UpdatePublicKey::from_bytes(self.config.public_key.0),
            &ash_product_update::ExpectedRelease {
                product: self.config.product,
                policy: self.config.policy,
                target: self.config.target.clone(),
            },
        )
        .map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))?;
        if release.package.format != self.config.package_format {
            return Err(invalid_update(
                "signed update package format does not match this product",
            ));
        }
        let version = AppVersion(release.version);
        if version <= self.config.current_version {
            return Ok(None);
        }
        Ok(Some(UpdateRelease {
            version,
            artifact: UpdateArtifact {
                url: ExternalUrl::parse(release.package.url)
                    .map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))?,
                file_name: release.package.file_name,
                sha256: release.package.sha256,
                size: release.package.size,
            },
        }))
    }
}

impl UpdateService for SignedHttpUpdater {
    fn check(&self) -> Result<Option<UpdateRelease>, SystemServiceError> {
        let bytes = self.transport.get(&self.config.manifest_url)?;
        self.parse_manifest(&bytes)
    }

    fn download(&self, release: UpdateRelease) -> Result<StagedUpdate, SystemServiceError> {
        let bytes = self.transport.get(&release.artifact.url)?;
        if bytes.len() as u64 != release.artifact.size {
            return Err(invalid_update(
                "downloaded artifact size does not match signed release",
            ));
        }
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if digest != release.artifact.sha256 {
            return Err(invalid_update(
                "downloaded artifact SHA-256 does not match manifest",
            ));
        }
        std::fs::create_dir_all(&self.config.staging_directory)
            .map_err(|source| SystemServiceError::backend(UPDATE_SERVICE, source))?;
        let path = self
            .config
            .staging_directory
            .join(&release.artifact.file_name);
        if path.exists() {
            return Err(invalid_update("staged update path already exists"));
        }
        let temporary = self.config.staging_directory.join(format!(
            ".{}.{}.part",
            release.artifact.file_name,
            std::process::id()
        ));
        let write_result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)
        })();
        if let Err(source) = write_result {
            let _ = std::fs::remove_file(&temporary);
            return Err(SystemServiceError::backend(UPDATE_SERVICE, source));
        }
        Ok(StagedUpdate { release, path })
    }

    fn install(&self, update: &StagedUpdate) -> Result<(), SystemServiceError> {
        self.installer.launch(&update.path)
    }
}

fn invalid_update(message: &'static str) -> SystemServiceError {
    SystemServiceError::backend(UPDATE_SERVICE, std::io::Error::other(message))
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
