//! Resolution of the Ash data root on the machine running this process.

use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::path::PathBuf;

/// Resolves `ASH_HOME`, or the current user's `.ash` directory when unset.
///
/// The result is absolute, with existing directory aliases resolved. Missing directories are
/// allowed and are not created. Invalid overrides and the retired `ASH_PROFILE_ROOT` variable
/// are errors; a working directory is never used to select the data root.
pub fn find_ash_home() -> io::Result<PathBuf> {
    resolve_from(
        std::env::var_os("ASH_HOME").as_deref(),
        std::env::var_os("ASH_PROFILE_ROOT").as_deref(),
        dirs::home_dir().as_deref(),
    )
}

fn resolve_from(
    configured: Option<&OsStr>,
    legacy: Option<&OsStr>,
    user_home: Option<&Path>,
) -> io::Result<PathBuf> {
    if legacy.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "ASH_PROFILE_ROOT has been replaced by ASH_HOME; remove ASH_PROFILE_ROOT and set ASH_HOME to the same absolute directory to retain your data",
        ));
    }
    let path = match configured {
        Some(value) => PathBuf::from(value),
        None => user_home
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "could not find user home directory; set ASH_HOME to an absolute directory",
                )
            })?
            .join(".ash"),
    };
    resolve_path(&path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("invalid ASH_HOME {}: {error}", path.display()),
        )
    })
}

/// Validates a selected data directory and resolves existing directory aliases without creating it.
///
/// Used for explicit host resource roots as well as the process-wide Ash home. Existing files,
/// dangling links, relative paths, and inaccessible ancestors are rejected.
pub fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a non-empty absolute directory path",
        ));
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => dunce::canonicalize(path),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "path is not a directory",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match std::fs::symlink_metadata(path) {
                Ok(_) => return Err(error),
                Err(link_error) if link_error.kind() == io::ErrorKind::NotFound => {}
                Err(link_error) => return Err(link_error),
            }
            let name = path.file_name().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "missing directory has no final component",
                )
            })?;
            let parent = path.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "directory has no parent")
            })?;
            Ok(resolve_path(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "home_dir_tests.rs"]
mod tests;
