use std::fs;
use std::path::Path;

use tempfile::TempDir;
use tough::ExpirationEnforcement;
use tough::FilesystemTransport;
use tough::Limits;
use tough::Repository;
use tough::RepositoryLoader;
use tough::TargetName;

use super::RemoteMarketplaceConfig;
use super::directory_url;
use crate::MarketplaceClientError;

pub(super) async fn cache_repository(
    config: &RemoteMarketplaceConfig,
    repository: &Repository,
    package_targets: &[TargetName],
) -> Result<(), MarketplaceClientError> {
    let root = config.cache_root.join("repository");
    let staging = tempfile::Builder::new()
        .prefix(".repository-")
        .tempdir_in(&config.cache_root)
        .map_err(|_| MarketplaceClientError::storage())?;
    let metadata = staging.path().join("metadata");
    let targets = staging.path().join("targets");
    let mut target_names = vec!["marketplace/revocations.json".to_owned()];
    target_names.extend(package_targets.iter().map(|name| name.raw().to_owned()));
    repository
        .cache(&metadata, &targets, Some(&target_names), true)
        .await
        .map_err(|_| MarketplaceClientError::storage())?;
    replace_directory(staging, &root)
}

pub(super) async fn open_cached_repository(
    config: &RemoteMarketplaceConfig,
) -> Result<Repository, MarketplaceClientError> {
    let root = config.cache_root.join("repository");
    let metadata = directory_url(&root.join("metadata"))?;
    let targets = directory_url(&root.join("targets"))?;
    let datastore = config.cache_root.join("tuf");
    fs::create_dir_all(&datastore).map_err(|_| MarketplaceClientError::storage())?;
    RepositoryLoader::new(&config.trusted_root, metadata, targets)
        .transport(FilesystemTransport)
        .datastore(datastore)
        .limits(Limits::default())
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .load()
        .await
        .map_err(|_| MarketplaceClientError::package_untrusted())
}

pub(super) fn prepare_cache_root(root: &Path) -> Result<(), MarketplaceClientError> {
    if root.exists() {
        let metadata = fs::symlink_metadata(root).map_err(|_| MarketplaceClientError::storage())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(MarketplaceClientError::storage());
        }
    } else {
        fs::create_dir_all(root).map_err(|_| MarketplaceClientError::storage())?;
    }
    recover_directory(root, "repository")?;
    recover_directory(root, "tuf")
}

pub(super) fn stage_datastore(
    root: &Path,
    current: &Path,
) -> Result<TempDir, MarketplaceClientError> {
    let staging = tempfile::Builder::new()
        .prefix(".tuf-state-")
        .tempdir_in(root)
        .map_err(|_| MarketplaceClientError::storage())?;
    if !current.exists() {
        return Ok(staging);
    }
    let metadata = fs::symlink_metadata(current).map_err(|_| MarketplaceClientError::storage())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MarketplaceClientError::storage());
    }
    for entry in fs::read_dir(current).map_err(|_| MarketplaceClientError::storage())? {
        let entry = entry.map_err(|_| MarketplaceClientError::storage())?;
        if !entry
            .file_type()
            .map_err(|_| MarketplaceClientError::storage())?
            .is_file()
        {
            return Err(MarketplaceClientError::storage());
        }
        fs::copy(entry.path(), staging.path().join(entry.file_name()))
            .map_err(|_| MarketplaceClientError::storage())?;
    }
    Ok(staging)
}

pub(super) fn replace_directory(
    staging: TempDir,
    destination: &Path,
) -> Result<(), MarketplaceClientError> {
    let source = staging.keep();
    let backup = destination.with_extension("previous");
    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|_| MarketplaceClientError::storage())?;
    }
    if destination.exists() {
        fs::rename(destination, &backup).map_err(|_| MarketplaceClientError::storage())?;
    }
    if fs::rename(&source, destination).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(MarketplaceClientError::storage());
    }
    if backup.exists() {
        fs::remove_dir_all(backup).map_err(|_| MarketplaceClientError::storage())?;
    }
    Ok(())
}

fn recover_directory(root: &Path, name: &str) -> Result<(), MarketplaceClientError> {
    let current = root.join(name);
    let backup = current.with_extension("previous");
    match (current.exists(), backup.exists()) {
        (false, true) => fs::rename(backup, current).map_err(|_| MarketplaceClientError::storage()),
        (true, true) => fs::remove_dir_all(backup).map_err(|_| MarketplaceClientError::storage()),
        _ => Ok(()),
    }
}
