use std::fs;
use std::fs::Metadata;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::ArtifactHandle;
use crate::MarketplaceClientError;
use crate::PackageRef;
use crate::PluginPackagePayload;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::Digest;
use sha2::Sha256;

const PACKAGE_DIGEST_DOMAIN: &[u8] = b"marketplace-package-v1\0";
const MAX_PACKAGE_FILES: usize = 10_000;
const MAX_PACKAGE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) struct Store {
    root: PathBuf,
    artifacts: PathBuf,
    state: PathBuf,
}

impl Store {
    pub(crate) fn open(root: PathBuf) -> Result<Self, MarketplaceClientError> {
        fs::create_dir_all(&root).map_err(|_| MarketplaceClientError::storage())?;
        let root = root
            .canonicalize()
            .map_err(|_| MarketplaceClientError::storage())?;
        let artifacts = root.join("artifacts");
        fs::create_dir_all(&artifacts).map_err(|_| MarketplaceClientError::storage())?;
        Ok(Self {
            state: root.join("manager-state.json"),
            root,
            artifacts,
        })
    }

    pub(crate) fn materialize(
        &self,
        downloaded: &dyn PluginPackagePayload,
    ) -> Result<ArtifactHandle, MarketplaceClientError> {
        let package = downloaded.package().clone();
        if let Some(inspected) = self.inspect_artifact(&package)? {
            validate_statistics(&inspected, downloaded)?;
            return Ok(artifact_handle(package));
        }
        let digest = digest_component(&package.digest)?;
        let destination = self.artifacts.join(digest);
        let staging = tempfile::Builder::new()
            .prefix(".artifact-")
            .tempdir_in(&self.artifacts)
            .map_err(|_| MarketplaceClientError::storage())?;
        downloaded.copy_to(staging.path())?;
        let inspected = inspect_tree(staging.path())?;
        if inspected.digest != package.digest {
            return Err(MarketplaceClientError::package_untrusted());
        }
        validate_statistics(&inspected, downloaded)?;
        if let Err(error) = fs::rename(staging.path(), &destination) {
            if !matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
            ) {
                return Err(MarketplaceClientError::storage());
            }
            // Concurrent installs of the same digest share one immutable artifact. The winner
            // must satisfy this provider's exact payload contract before it can be reused.
            let existing = self
                .inspect_artifact(&package)?
                .ok_or_else(MarketplaceClientError::storage)?;
            validate_statistics(&existing, downloaded)?;
        }
        Ok(artifact_handle(package))
    }

    fn inspect_artifact(
        &self,
        package: &PackageRef,
    ) -> Result<Option<TreeInspection>, MarketplaceClientError> {
        let digest = digest_component(&package.digest)?;
        let destination = self.artifacts.join(digest);
        if !destination.exists() {
            return Ok(None);
        }
        let inspected = inspect_tree(&destination)?;
        if inspected.digest != package.digest {
            return Err(MarketplaceClientError::storage());
        }
        Ok(Some(inspected))
    }

    pub(crate) fn read_package_file(
        &self,
        package: &PackageRef,
        relative: &str,
    ) -> Result<Vec<u8>, MarketplaceClientError> {
        let relative = safe_relative_path(relative)?;
        let root = self.artifacts.join(digest_component(&package.digest)?);
        let path = root.join(relative);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| MarketplaceClientError::storage())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_PACKAGE_FILE_BYTES
        {
            return Err(MarketplaceClientError::storage());
        }
        fs::read(path).map_err(|_| MarketplaceClientError::storage())
    }

    pub(crate) fn verified_package_path(
        &self,
        package: &PackageRef,
        relative: &str,
    ) -> Result<PathBuf, MarketplaceClientError> {
        self.inspect_artifact(package)?
            .ok_or_else(MarketplaceClientError::storage)?;
        let relative = safe_relative_path(relative)?;
        let artifact = self.artifacts.join(digest_component(&package.digest)?);
        let path = artifact.join(relative);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| MarketplaceClientError::storage())?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(MarketplaceClientError::storage());
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| MarketplaceClientError::storage())?;
        if !canonical.starts_with(&artifact) {
            return Err(MarketplaceClientError::storage());
        }
        Ok(canonical)
    }

    pub(crate) fn verified_package_root(
        &self,
        package: &PackageRef,
    ) -> Result<PathBuf, MarketplaceClientError> {
        self.inspect_artifact(package)?
            .ok_or_else(MarketplaceClientError::storage)?;
        self.artifacts
            .join(digest_component(&package.digest)?)
            .canonicalize()
            .map_err(|_| MarketplaceClientError::storage())
    }

    pub(crate) fn read_state<T>(&self) -> Result<T, MarketplaceClientError>
    where
        T: Default + DeserializeOwned,
    {
        if !self.state.exists() {
            return Ok(T::default());
        }
        let bytes = fs::read(&self.state).map_err(|_| MarketplaceClientError::storage())?;
        serde_json::from_slice(&bytes).map_err(|_| MarketplaceClientError::storage())
    }

    pub(crate) fn write_state<T>(&self, state: &T) -> Result<(), MarketplaceClientError>
    where
        T: Serialize,
    {
        let mut staging = tempfile::NamedTempFile::new_in(&self.root)
            .map_err(|_| MarketplaceClientError::storage())?;
        serde_json::to_writer(&mut staging, state)
            .map_err(|_| MarketplaceClientError::storage())?;
        staging
            .flush()
            .map_err(|_| MarketplaceClientError::storage())?;
        staging
            .as_file()
            .sync_all()
            .map_err(|_| MarketplaceClientError::storage())?;
        staging
            .persist(&self.state)
            .map_err(|_| MarketplaceClientError::storage())?;
        Ok(())
    }
}

pub(crate) fn opaque_id(prefix: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"marketplace-opaque-id-v1\0");
    hasher.update(prefix.as_bytes());
    for value in values {
        hasher.update([0]);
        hasher.update(value.as_bytes());
    }
    format!(
        "{prefix}_{}",
        encode_hex(&hasher.finalize())[..32].to_owned()
    )
}

pub(crate) struct TreeInspection {
    pub(crate) digest: String,
    pub(crate) file_count: u64,
    pub(crate) total_bytes: u64,
}

fn artifact_handle(package: PackageRef) -> ArtifactHandle {
    ArtifactHandle {
        id: opaque_id("art", &[&package.digest]),
        package,
    }
}

fn validate_statistics(
    inspected: &TreeInspection,
    payload: &dyn PluginPackagePayload,
) -> Result<(), MarketplaceClientError> {
    if inspected.file_count != payload.expected_file_count()
        || inspected.total_bytes != payload.expected_size_bytes()
    {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(())
}

pub(crate) fn inspect_tree(root: &Path) -> Result<TreeInspection, MarketplaceClientError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| MarketplaceClientError::storage())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MarketplaceClientError::storage());
    }
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    hasher.update(PACKAGE_DIGEST_DOMAIN);
    let mut total_bytes = 0_u64;
    let file_count = files.len() as u64;
    for (relative, absolute, expected) in files {
        total_bytes = total_bytes
            .checked_add(expected.len())
            .ok_or_else(MarketplaceClientError::storage)?;
        if total_bytes > MAX_PACKAGE_TOTAL_BYTES {
            return Err(MarketplaceClientError::storage());
        }
        update_length(&mut hasher, relative.len() as u64);
        hasher.update(relative.as_bytes());
        update_length(&mut hasher, expected.len());
        hash_file(&mut hasher, &absolute, &expected)?;
    }
    Ok(TreeInspection {
        digest: format!("sha256:{}", encode_hex(&hasher.finalize())),
        file_count,
        total_bytes,
    })
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf, Metadata)>,
) -> Result<(), MarketplaceClientError> {
    let mut children = fs::read_dir(directory)
        .map_err(|_| MarketplaceClientError::storage())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MarketplaceClientError::storage())?;
    children.sort_by_key(fs::DirEntry::file_name);
    for child in children {
        let absolute = child.path();
        let metadata =
            fs::symlink_metadata(&absolute).map_err(|_| MarketplaceClientError::storage())?;
        if metadata.file_type().is_symlink() {
            return Err(MarketplaceClientError::storage());
        }
        if metadata.is_dir() {
            collect_files(root, &absolute, files)?;
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_PACKAGE_FILE_BYTES {
            return Err(MarketplaceClientError::storage());
        }
        if files.len() >= MAX_PACKAGE_FILES {
            return Err(MarketplaceClientError::storage());
        }
        let relative = absolute
            .strip_prefix(root)
            .map_err(|_| MarketplaceClientError::storage())?
            .to_str()
            .ok_or_else(MarketplaceClientError::storage)?
            .replace('\\', "/");
        files.push((relative, absolute, metadata));
    }
    Ok(())
}

fn hash_file(
    hasher: &mut Sha256,
    path: &Path,
    expected: &Metadata,
) -> Result<(), MarketplaceClientError> {
    let mut file = fs::File::open(path).map_err(|_| MarketplaceClientError::storage())?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| MarketplaceClientError::storage())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(MarketplaceClientError::storage)?;
        hasher.update(&buffer[..read]);
    }
    let actual = fs::symlink_metadata(path).map_err(|_| MarketplaceClientError::storage())?;
    if actual.file_type().is_symlink()
        || !actual.is_file()
        || total != expected.len()
        || actual.len() != expected.len()
    {
        return Err(MarketplaceClientError::storage());
    }
    Ok(())
}

fn safe_relative_path(value: &str) -> Result<PathBuf, MarketplaceClientError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MarketplaceClientError::storage());
    }
    Ok(path.to_path_buf())
}

fn digest_component(value: &str) -> Result<&str, MarketplaceClientError> {
    let Some(value) = value.strip_prefix("sha256:") else {
        return Err(MarketplaceClientError::storage());
    };
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(MarketplaceClientError::storage());
    }
    Ok(value)
}

fn update_length(hasher: &mut Sha256, length: u64) {
    hasher.update(length.to_be_bytes());
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}
