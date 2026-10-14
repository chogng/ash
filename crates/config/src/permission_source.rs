//! System permission source, outside user and directory configuration authorities.
use crate::ConfigError;
use crate::PermissionRequirements;
use std::io::Read;
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedPermissions {
    pub source: PathBuf,
    pub values: PermissionRequirements,
}

pub fn load_system_permission_requirements() -> Result<ManagedPermissions, ConfigError> {
    let source = system_path().map_err(|error| ConfigError(error.to_string()))?;
    let file = match std::fs::File::open(&source) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedPermissions {
                source,
                values: PermissionRequirements::default(),
            });
        }
        Err(error) => {
            return Err(ConfigError(format!(
                "cannot read system permissions {}: {error}",
                source.display()
            )));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|error| ConfigError(error.to_string()))?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(ConfigError(
            "system permission requirements must be a bounded regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(ConfigError("system permission requirements must be administrator-owned and not writable by other users".into()));
        }
        let canonical =
            std::fs::canonicalize(&source).map_err(|error| ConfigError(error.to_string()))?;
        for parent in canonical
            .parent()
            .into_iter()
            .flat_map(|path| path.ancestors())
            .chain(
                source
                    .parent()
                    .into_iter()
                    .flat_map(|path| path.ancestors()),
            )
        {
            let metadata =
                std::fs::metadata(parent).map_err(|error| ConfigError(error.to_string()))?;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err(ConfigError(
                    "system permission source has a writable ancestor".into(),
                ));
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if std::fs::symlink_metadata(&source)
            .map_err(|error| ConfigError(error.to_string()))?
            .file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(ConfigError(
                "system permission file cannot be a reparse point".into(),
            ));
        }
        ash_file_identity::validate_administrator_owned(&file)
            .map_err(|error| ConfigError(error.to_string()))?;
        let canonical =
            std::fs::canonicalize(&source).map_err(|error| ConfigError(error.to_string()))?;
        for parent in canonical
            .parent()
            .into_iter()
            .flat_map(|path| path.ancestors())
            .chain(
                source
                    .parent()
                    .into_iter()
                    .flat_map(|path| path.ancestors()),
            )
        {
            use std::os::windows::fs::OpenOptionsExt;
            let guard = std::fs::OpenOptions::new()
                .read(true)
                .access_mode(windows_sys::Win32::Storage::FileSystem::READ_CONTROL)
                .custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS
                        | windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                )
                .open(parent)
                .map_err(|error| ConfigError(error.to_string()))?;
            ash_file_identity::validate_administrator_owned(&guard)
                .map_err(|error| ConfigError(error.to_string()))?;
        }
    }
    let mut contents = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut contents)
        .map_err(|error| ConfigError(error.to_string()))?;
    if contents.len() > 1024 * 1024 {
        return Err(ConfigError(
            "system permission requirements exceed the size limit".into(),
        ));
    }
    let values: PermissionRequirements = toml::from_str(&contents).map_err(|error| {
        ConfigError(format!(
            "invalid system permission requirements {}: {error}",
            source.display()
        ))
    })?;
    values.validate()?;
    Ok(ManagedPermissions { source, values })
}

#[cfg(unix)]
fn system_path() -> std::io::Result<PathBuf> {
    Ok(PathBuf::from("/etc/ash/requirements.toml"))
}

#[cfg(windows)]
fn system_path() -> std::io::Result<PathBuf> {
    Ok(ash_file_identity::common_application_data_dir()?
        .join("Ash")
        .join("requirements.toml"))
}
