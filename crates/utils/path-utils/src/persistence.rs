#[cfg(windows)]
use std::ffi::OsString;
use std::io;
use std::io::Write;
#[cfg(windows)]
use std::path::Component;
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::path::Prefix;
use tempfile::NamedTempFile;

/// Atomically replaces a file with the supplied bytes.
///
/// The parent directory is created first. Bytes are flushed to the temporary
/// file before it is renamed over `write_path`. Failures before rename leave
/// the previous destination intact. A parent-directory sync failure is reported
/// after the replacement has become visible.
pub fn write_atomically(write_path: &Path, contents: &[u8]) -> io::Result<()> {
    #[cfg(windows)]
    let filesystem_path = filesystem_path(write_path)?;
    #[cfg(windows)]
    let write_path = filesystem_path.as_path();
    let parent = write_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path {} has no parent directory", write_path.display()),
        )
    })?;
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let permissions = match std::fs::metadata(write_path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    std::fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(contents)?;
    if let Some(permissions) = permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(write_path).map_err(|error| error.error)?;
    sync_parent(parent)
}

#[cfg(windows)]
pub(super) fn filesystem_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let Some(Component::Prefix(prefix)) = absolute.components().next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows filesystem path has no volume prefix",
        ));
    };
    match prefix.kind() {
        Prefix::Disk(_) => {
            let mut extended = OsString::from(r"\\?\");
            extended.push(absolute.as_os_str());
            Ok(PathBuf::from(extended))
        }
        Prefix::UNC(server, share) => {
            let mut extended = OsString::from(r"\\?\UNC\");
            extended.push(server);
            extended.push(r"\");
            extended.push(share);
            for component in absolute.components().skip(2) {
                extended.push(r"\");
                extended.push(component.as_os_str());
            }
            Ok(PathBuf::from(extended))
        }
        _ => Ok(absolute),
    }
}

fn sync_parent(parent: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(parent)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        Ok(())
    }
}
