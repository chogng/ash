use crate::FastRegexError;
use crate::FastRegexSearchLimits;
use crate::file_stamp::FileStamp;
use ash_file_access::Dir;
use ignore::WalkBuilder;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

pub(crate) fn scan_dir(
    root: &Dir,
    limits: &FastRegexSearchLimits,
) -> Result<Vec<(PathBuf, String, FileStamp)>, FastRegexError> {
    let paths = dir_paths(root)?;
    let mut source_bytes = 0usize;
    let mut documents = Vec::new();
    for path in paths {
        let absolute = root.canonical_path().join(&path);
        let Some((content, stamp)) = read_text_file_with_stamp(&absolute, limits.max_file_bytes)?
        else {
            continue;
        };
        source_bytes = source_bytes.saturating_add(content.len());
        limits.check_capacity(documents.len() + 1, source_bytes)?;
        documents.push((path, content, stamp));
    }
    Ok(documents)
}

pub(crate) fn scan_dir_stamps(
    root: &Dir,
    limits: &FastRegexSearchLimits,
) -> Result<BTreeMap<PathBuf, FileStamp>, FastRegexError> {
    let mut stamps = BTreeMap::new();
    for path in dir_paths(root)? {
        let absolute = root.canonical_path().join(&path);
        let stamp = FileStamp::read(&absolute).map_err(|source| io_error(&absolute, source))?;
        if stamp.length <= limits.max_file_bytes as u64 {
            stamps.insert(path, stamp);
        }
    }
    Ok(stamps)
}

pub(crate) fn read_text_file(
    path: &Path,
    max_bytes: usize,
) -> Result<Option<String>, FastRegexError> {
    #[cfg(test)]
    SOURCE_READ_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let file = fs::File::open(path).map_err(|source| io_error(path, source))?;
    let length = file
        .metadata()
        .map_err(|source| io_error(path, source))?
        .len();
    if length > max_bytes as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(path, source))?;
    if bytes.len() > max_bytes || bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

pub(crate) fn read_text_file_with_stamp(
    path: &Path,
    max_bytes: usize,
) -> Result<Option<(String, FileStamp)>, FastRegexError> {
    for _ in 0..3 {
        let before = FileStamp::read(path).map_err(|source| io_error(path, source))?;
        let content = read_text_file(path, max_bytes)?;
        let after = FileStamp::read(path).map_err(|source| io_error(path, source))?;
        if before == after {
            return Ok(content.map(|content| (content, after)));
        }
    }
    Err(io_error(
        path,
        std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "file changed repeatedly while indexing",
        ),
    ))
}

pub(crate) fn dir_walk_builder(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(true).follow_links(false).require_git(true);
    builder
}

fn dir_paths(root: &Dir) -> Result<Vec<PathBuf>, FastRegexError> {
    let mut paths = Vec::new();
    for entry in dir_walk_builder(root.canonical_path()).build() {
        let entry =
            entry.map_err(|error| io_error(root.canonical_path(), std::io::Error::other(error)))?;
        if let Some(error) = entry.error() {
            return Err(io_error(
                entry.path(),
                std::io::Error::other(error.to_string()),
            ));
        }
        if entry.file_type().is_some_and(|kind| kind.is_file()) {
            let relative = entry
                .path()
                .strip_prefix(root.canonical_path())
                .map_err(|error| io_error(entry.path(), std::io::Error::other(error)))?;
            paths.push(relative.to_path_buf());
        }
    }
    paths.sort();
    Ok(paths)
}

#[cfg(test)]
thread_local! {
    static SOURCE_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_source_read_count() -> usize {
    SOURCE_READ_COUNT.with(|count| count.replace(0))
}

fn io_error(path: &Path, source: std::io::Error) -> FastRegexError {
    FastRegexError::Io {
        path: path.to_path_buf(),
        source,
    }
}
