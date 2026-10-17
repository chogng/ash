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
use std::path::Path;
use std::path::PathBuf;

const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;

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
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&root.join("install.lock"))
        .map_err(|_| CapabilityInstallError::Unavailable)?;
    lock.lock_exclusive()
        .map_err(|_| CapabilityInstallError::Unavailable)?;
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
