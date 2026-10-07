use crate::{ConfigError, UserConfigDocument};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn read_document(path: &Path) -> Result<UserConfigDocument, ConfigError> {
    if !path.exists() {
        return Ok(UserConfigDocument::default());
    }
    let source = fs::read_to_string(path).map_err(io_error)?;
    let decoded = crate::document_migration::decode(&source).map_err(|error| {
        ConfigError(format!(
            "invalid user configuration '{}': {error}",
            path.display()
        ))
    })?;
    if decoded.rewrite_required {
        write_document(path, &decoded.document)?;
    }
    Ok(decoded.document)
}

pub(crate) fn write_document(
    path: &Path,
    document: &UserConfigDocument,
) -> Result<(), ConfigError> {
    document.validate()?;
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let encoded = crate::document_migration::encode(document)?;
    let temporary = temporary_path(path);
    let result = write_and_replace(path, &temporary, encoded.as_bytes());
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn write_document_if_unchanged(
    path: &Path,
    expected_digest: &str,
    document: &UserConfigDocument,
) -> Result<(), ConfigError> {
    let observed = read_document(path)?;
    if document_digest(&observed)? != expected_digest {
        return Err(ConfigError(
            "user configuration changed while applying a command; read the latest revision and retry"
                .into(),
        ));
    }
    write_document(path, document)
}

pub(crate) fn document_digest(document: &UserConfigDocument) -> Result<String, ConfigError> {
    let canonical = serde_json::to_vec(document).map_err(|error| ConfigError(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

fn write_and_replace(path: &Path, temporary: &Path, contents: &[u8]) -> Result<(), ConfigError> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(temporary).map_err(io_error)?;
    file.write_all(contents).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::rename(temporary, path).map_err(io_error)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let sequence = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.toml");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ))
}

fn io_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(error.to_string())
}
