//! Product-bound capability downloads using the package store's publication and selection.

use crate::PackageIdentity;
use crate::PackageStore;
use ash_http_client::HttpClient;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_product_update::PackageFormat;
use ash_product_update::VerifiedPackage;
use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;

/// Upstream single-executable archive format; ZIP entries are never extracted as paths.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutableArchive {
    Gzip,
    Zip,
}

/// An exact upstream release pinned by the product, never supplied by an untrusted server.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableRelease {
    pub version: String,
    pub target: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub format: ExecutableArchive,
}

/// The lease must outlive all child processes using this immutable executable.
pub struct InstalledExecutable {
    pub path: PathBuf,
    pub lease: crate::PackageLease,
}

/// Installs a pinned upstream executable through the capability store. Failed downloads do not
/// change selection; concurrent processes share the lock and reuse the validated generation.
/// Calls `on_download` only before an HTTP request, after locked cache validation and reuse.
pub fn install_executable(
    home: &Path,
    kind: &str,
    binary: &str,
    release: &ExecutableRelease,
    http: &dyn HttpClient,
    on_download: impl FnOnce(),
) -> Result<InstalledExecutable, CapabilityInstallError> {
    let valid_name = |name: &str| {
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let url = url::Url::parse(&release.url).map_err(|_| CapabilityInstallError::Invalid)?;
    if !valid_name(kind)
        || !valid_name(binary)
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || release.size == 0
        || release.size > MAX_ARCHIVE_BYTES
        || release.sha256.len() != 64
        || !release
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CapabilityInstallError::Invalid);
    }
    let root = home.join("capabilities").join(kind);
    let store = PackageStore::open(&root).map_err(|_| CapabilityInstallError::Unavailable)?;
    let _lock = install_lock(&root)?;
    let binding = serde_json::to_value(release).map_err(|_| CapabilityInstallError::Invalid)?;
    let name = format!("{binary}{}", std::env::consts::EXE_SUFFIX);
    let installed = |root: PathBuf| -> Result<InstalledExecutable, CapabilityInstallError> {
        validate_capability_package(&root, kind)?;
        let lease =
            crate::PackageLease::acquire(&root).map_err(|_| CapabilityInstallError::Unavailable)?;
        let path = root
            .join("bin")
            .join(&name)
            .canonicalize()
            .map_err(|_| CapabilityInstallError::Invalid)?;
        Ok(InstalledExecutable { path, lease })
    };
    if let Some(selected) = store
        .current()
        .map_err(|_| CapabilityInstallError::Unavailable)?
        && selected.installation.as_ref() == Some(&binding)
    {
        return installed(selected.package_root);
    }
    let request = HttpRequest::new(HttpMethod::Get, &release.url, Vec::new(), Vec::new())
        .map_err(|_| CapabilityInstallError::Invalid)?;
    on_download();
    let response = http
        .execute(&request)
        .map_err(|_| CapabilityInstallError::Connection)?;
    if response.status() != 200 || response.body().len() as u64 != release.size {
        return Err(CapabilityInstallError::Connection);
    }
    use sha2::Digest;
    if format!("{:x}", sha2::Sha256::digest(response.body())) != release.sha256 {
        return Err(CapabilityInstallError::Invalid);
    }
    let temporary = tempfile::Builder::new()
        .prefix("capability-install-")
        .tempdir_in(&root)
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    let staging = temporary.path().join("package");
    std::fs::create_dir_all(staging.join("bin"))
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    let executable = staging.join("bin").join(&name);
    let mut output =
        std::fs::File::create(&executable).map_err(|_| CapabilityInstallError::Unavailable)?;
    // Bound decompression independently from download size. ZIP must contain exactly the
    // expected executable: directories, links, traversal and unrelated files are rejected.
    let mut reader: Box<dyn Read + '_> = match release.format {
        ExecutableArchive::Gzip => Box::new(flate2::read::GzDecoder::new(response.body())),
        ExecutableArchive::Zip => {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(response.body()))
                .map_err(|_| CapabilityInstallError::Invalid)?;
            if zip.len() != 1 {
                return Err(CapabilityInstallError::Invalid);
            }
            let mut entry = zip
                .by_index(0)
                .map_err(|_| CapabilityInstallError::Invalid)?;
            if entry.name().map_err(|_| CapabilityInstallError::Invalid)? != name
                || entry.is_dir()
                || entry.is_symlink()
                || entry.size() > MAX_ARCHIVE_BYTES
            {
                return Err(CapabilityInstallError::Invalid);
            }
            let mut bytes = Vec::new();
            (&mut entry)
                .take(MAX_ARCHIVE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| CapabilityInstallError::Invalid)?;
            Box::new(std::io::Cursor::new(bytes))
        }
    };
    let size = std::io::copy(
        &mut reader.by_ref().take(MAX_ARCHIVE_BYTES + 1),
        &mut output,
    )
    .map_err(|_| CapabilityInstallError::Invalid)?;
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err(CapabilityInstallError::Invalid);
    }
    output
        .sync_all()
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    drop(output);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .map_err(|_| CapabilityInstallError::Unavailable)?;
    }
    crate::store::write_executable_metadata(
        &staging,
        kind,
        &release.version,
        &release.target,
        &release.sha256,
    )
    .map_err(|_| CapabilityInstallError::Invalid)?;
    validate_capability_package(&staging, kind)?;
    let selected = store
        .publish_with_installation(&staging, binding)
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    installed(selected.package_root)
}

fn install_lock(root: &Path) -> Result<std::fs::File, CapabilityInstallError> {
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("install.lock"))
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    lock.lock_exclusive()
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    Ok(lock)
}

#[derive(Debug, thiserror::Error)]
pub enum CapabilityInstallError {
    #[error("capability package is unavailable")]
    Unavailable,
    #[error("invalid capability package or release")]
    Invalid,
    #[error("capability download failed")]
    Connection,
}

/// Product release binding or an explicitly selected offline package directory.
pub enum CapabilitySource<'a> {
    ProductBound,
    Directory(&'a Path),
}

/// Installs an exact capability generation on explicit request, without activating it.
/// The kind selects both the product-bound descriptor and the profile's existing store.
/// Failed updates leave the previous selection intact; concurrent callers share one download.
pub fn install_capability(
    home: &Path,
    kind: &str,
    source: CapabilitySource<'_>,
    http: &dyn HttpClient,
) -> Result<PathBuf, CapabilityInstallError> {
    if kind.is_empty()
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(CapabilityInstallError::Invalid);
    }
    let release = match source {
        CapabilitySource::Directory(path) => {
            if !path.is_absolute() {
                return Err(CapabilityInstallError::Unavailable);
            }
            let identity = validate_capability_package(path, kind)?;
            Some(Release {
                schema_version: 1,
                target: identity.target,
                build_id: identity.build_id,
                source: Source::Directory {
                    path: path.to_owned(),
                },
            })
        }
        CapabilitySource::ProductBound => {
            let context = ash_install_context::InstallContext::current();
            context
                .bundled_resource(&format!("capabilities/{kind}.json"))
                .map(|path| {
                    // Immutable product metadata binds the exact downloadable executable bytes.
                    let layout = context
                        .package_layout()
                        .ok_or(CapabilityInstallError::Unavailable)?;
                    crate::validate_package_identity(layout.package_directory())
                        .map_err(|_| CapabilityInstallError::Invalid)?;
                    read_release(&path)
                })
                .transpose()?
        }
    };
    install(home, release.as_ref(), http, kind)
}

/// Resolves an executable from an offline capability, the bundled product, or its
/// bound on-demand download. Callers own profile/network selection and executable overrides.
pub fn resolve_capability_executable(
    home: &Path,
    kind: &str,
    binary: &str,
    source: CapabilitySource<'_>,
    http: &dyn HttpClient,
) -> Result<PathBuf, CapabilityInstallError> {
    if binary.is_empty()
        || !binary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CapabilityInstallError::Invalid);
    }
    let name = format!("{binary}{}", std::env::consts::EXE_SUFFIX);
    let root = match source {
        CapabilitySource::Directory(path) => {
            if !path.is_absolute() {
                return Err(CapabilityInstallError::Unavailable);
            }
            validate_capability_package(path, kind)?;
            path.to_owned()
        }
        CapabilitySource::ProductBound => {
            let context = ash_install_context::InstallContext::current();
            if let Some(layout) = context.package_layout()
                && layout.binary_directory().join(&name).is_file()
            {
                layout.package_directory().to_owned()
            } else {
                install_capability(home, kind, CapabilitySource::ProductBound, http)?
            }
        }
    };
    let path = root
        .join("bin")
        .join(name)
        .canonicalize()
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    if !path.starts_with(
        root.canonicalize()
            .map_err(|_| CapabilityInstallError::Unavailable)?,
    ) {
        return Err(CapabilityInstallError::Invalid);
    }
    Ok(path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release {
    schema_version: u32,
    target: String,
    build_id: String,
    source: Source,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Source {
    Directory {
        path: PathBuf,
    },
    Archive {
        url: String,
        sha256: String,
        size: u64,
    },
}

fn read_release(path: &Path) -> Result<Release, CapabilityInstallError> {
    if std::fs::metadata(path)
        .map_err(|_| CapabilityInstallError::Unavailable)?
        .len()
        > 64 * 1024
    {
        return Err(CapabilityInstallError::Invalid);
    }
    let release: Release = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| CapabilityInstallError::Unavailable)?,
    )
    .map_err(|_| CapabilityInstallError::Invalid)?;
    if release.schema_version != 1 || release.build_id.is_empty() || release.target.is_empty() {
        return Err(CapabilityInstallError::Invalid);
    }
    Ok(release)
}

fn install(
    home: &Path,
    release: Option<&Release>,
    http: &dyn HttpClient,
    kind: &str,
) -> Result<PathBuf, CapabilityInstallError> {
    let root = home.join("capabilities").join(kind);
    let store = PackageStore::open(&root).map_err(|_| CapabilityInstallError::Unavailable)?;
    // Serialize the download as well as publication across windows and processes. A failed
    // attempt leaves the previous selected generation intact and temporary bytes are removed.
    let _lock = install_lock(&root)?;
    if let Some(selected) = store
        .current()
        .map_err(|_| CapabilityInstallError::Unavailable)?
    {
        let identity = validate_capability_package(&selected.package_root, kind)?;
        if release.is_none_or(|release| {
            release.build_id == identity.build_id && release.target == identity.target
        }) {
            return selected
                .package_root
                .canonicalize()
                .map_err(|_| CapabilityInstallError::Unavailable);
        }
    }
    let release = release.ok_or(CapabilityInstallError::Unavailable)?;
    let temporary = tempfile::Builder::new()
        .prefix("capability-install-")
        .tempdir_in(&root)
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    let staging = temporary.path().join("package");
    match &release.source {
        Source::Directory { path } => copy_package(path, &staging, kind)?,
        Source::Archive { url, sha256, size } => {
            let parsed = url::Url::parse(url).map_err(|_| CapabilityInstallError::Invalid)?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
                || parsed.query().is_some()
                || *size == 0
                || *size > MAX_ARCHIVE_BYTES
            {
                return Err(CapabilityInstallError::Invalid);
            }
            if sha256.len() != 64
                || !sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(CapabilityInstallError::Invalid);
            }
            let mut digest = [0; 32];
            for (index, value) in digest.iter_mut().enumerate() {
                *value = u8::from_str_radix(&sha256[index * 2..index * 2 + 2], 16)
                    .map_err(|_| CapabilityInstallError::Invalid)?;
            }
            let request = HttpRequest::new(HttpMethod::Get, url, Vec::new(), Vec::new())
                .map_err(|_| CapabilityInstallError::Invalid)?;
            let response = http
                .execute(&request)
                .map_err(|_| CapabilityInstallError::Connection)?;
            if response.status() != 200 || response.body().len() as u64 != *size {
                return Err(CapabilityInstallError::Connection);
            }
            let archive = ash_product_update::stage_verified_package_with_reader(
                &VerifiedPackage {
                    url: url.clone(),
                    file_name: "capability.tar.gz".into(),
                    format: PackageFormat::TarGz,
                    size: *size,
                    sha256: digest,
                },
                temporary.path(),
                response.body(),
            )
            .map_err(|_| CapabilityInstallError::Invalid)?;
            std::fs::create_dir(&staging).map_err(|_| CapabilityInstallError::Unavailable)?;
            ash_product_update::extract_package(&archive, PackageFormat::TarGz, &staging)
                .map_err(|_| CapabilityInstallError::Invalid)?;
        }
    }
    let identity = validate_capability_package(&staging, kind)?;
    if identity.target != release.target || identity.build_id != release.build_id {
        return Err(CapabilityInstallError::Invalid);
    }
    let published = store
        .publish(&staging)
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    published
        .package_root
        .canonicalize()
        .map_err(|_| CapabilityInstallError::Unavailable)
}

/// Validates a package identity, capability kind and compatibility with this host.
pub fn validate_capability_package(
    path: &Path,
    kind: &str,
) -> Result<PackageIdentity, CapabilityInstallError> {
    let identity =
        crate::validate_package_identity(path).map_err(|_| CapabilityInstallError::Invalid)?;
    if identity.runtime_kind != kind {
        return Err(CapabilityInstallError::Invalid);
    }
    let expected_arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => return Err(CapabilityInstallError::Unavailable),
    };
    let expected_os = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux",
        "windows" => "pc-windows",
        _ => return Err(CapabilityInstallError::Unavailable),
    };
    if !identity
        .target
        .starts_with(&format!("{expected_arch}-{expected_os}"))
    {
        return Err(CapabilityInstallError::Invalid);
    }
    Ok(identity)
}

fn copy_package(
    source: &Path,
    destination: &Path,
    kind: &str,
) -> Result<(), CapabilityInstallError> {
    if !source.is_absolute() {
        return Err(CapabilityInstallError::Invalid);
    }
    validate_capability_package(source, kind)?;
    fn copy(source: &Path, destination: &Path) -> std::io::Result<()> {
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            if entry.file_name() == ".lease" {
                continue;
            }
            let kind = entry.file_type()?;
            let output = destination.join(entry.file_name());
            if kind.is_dir() {
                copy(&entry.path(), &output)?;
            } else if kind.is_file() {
                std::fs::copy(entry.path(), output)?;
            } else {
                return Err(std::io::Error::other("invalid capability package entry"));
            }
        }
        Ok(())
    }
    copy(source, destination).map_err(|_| CapabilityInstallError::Unavailable)
}

#[cfg(test)]
#[path = "installation_tests.rs"]
mod tests;
