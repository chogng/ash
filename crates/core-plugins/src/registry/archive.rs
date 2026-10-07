use std::collections::BTreeSet;
use std::fs;
use std::io::Cursor;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use zip::ZipArchive;

use crate::MarketplaceClientError;

pub(crate) const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub(crate) const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) fn extract(bytes: &[u8], destination: &Path) -> Result<(), MarketplaceClientError> {
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(MarketplaceClientError::package_untrusted());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| MarketplaceClientError::package_untrusted())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(MarketplaceClientError::package_untrusted());
    }
    fs::create_dir_all(destination).map_err(|_| MarketplaceClientError::storage())?;
    let mut paths = BTreeSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        if entry.is_symlink() || entry.encrypted() {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let path = safe_path(entry.name())?;
        if !paths.insert(path.clone()) {
            return Err(MarketplaceClientError::package_untrusted());
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(MarketplaceClientError::package_untrusted)?;
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|_| MarketplaceClientError::storage())?;
            continue;
        }
        if !entry.is_file() {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let parent = output
            .parent()
            .ok_or_else(MarketplaceClientError::package_untrusted)?;
        fs::create_dir_all(parent).map_err(|_| MarketplaceClientError::storage())?;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            let executable = entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0);
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        let expected = entry.size();
        let mut output = options
            .open(output)
            .map_err(|_| MarketplaceClientError::storage())?;
        let copied = std::io::copy(&mut entry.take(expected + 1), &mut output)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        if copied != expected {
            return Err(MarketplaceClientError::package_untrusted());
        }
        output
            .flush()
            .map_err(|_| MarketplaceClientError::storage())?;
    }
    Ok(())
}

fn safe_path(name: &str) -> Result<PathBuf, MarketplaceClientError> {
    if name.is_empty() || name.contains('\\') || name.contains('\0') {
        return Err(MarketplaceClientError::package_untrusted());
    }
    let path = Path::new(name);
    if path.components().any(|component| {
        !matches!(component, Component::Normal(_))
            && !(matches!(component, Component::CurDir) && name.ends_with('/'))
    }) {
        return Err(MarketplaceClientError::package_untrusted());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        if let Component::Normal(component) = component {
            normalized.push(component);
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(normalized)
}
