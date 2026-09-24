use std::io;
use std::path::{Path, PathBuf};

pub(super) fn canonical_directory(path: &Path) -> io::Result<PathBuf> {
    let directory = path.canonicalize()?;
    if directory.is_dir() {
        Ok(directory)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a directory", directory.display()),
        ))
    }
}

pub(super) fn read_child_directories(directory: &Path) -> io::Result<Vec<PathBuf>> {
    let mut directories = std::fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        directory_name(left)
            .to_lowercase()
            .cmp(&directory_name(right).to_lowercase())
            .then_with(|| left.cmp(right))
    });
    Ok(directories)
}

pub(super) fn directory_name(directory: &Path) -> String {
    directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| directory.display().to_string())
}

pub(super) fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(super) fn resolve_directory_query(directory: &Path, query: &str) -> Option<PathBuf> {
    if query.is_empty() || !looks_like_path(query) {
        return None;
    }
    let candidate = if query == "~" {
        home_directory()?
    } else if let Some(relative) = query
        .strip_prefix("~/")
        .or_else(|| query.strip_prefix("~\\"))
    {
        home_directory()?.join(relative)
    } else {
        let path = Path::new(query);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            directory.join(path)
        }
    };
    canonical_directory(&candidate).ok()
}

fn looks_like_path(query: &str) -> bool {
    Path::new(query).is_absolute()
        || query.starts_with('.')
        || query.starts_with('~')
        || query.contains('/')
        || query.contains('\\')
}
