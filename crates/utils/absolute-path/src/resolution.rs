//! Thread-local base and home directories that supply the missing half of a non-absolute
//! path spelling, plus the deserialization that consumes them.

use crate::AbsolutePathBuf;
use serde::Deserialize;
use serde::Deserializer;
use serde::de::Error;
use std::borrow::Cow;
use std::cell::RefCell;
use std::path::Path;
use std::path::PathBuf;
use std::thread::LocalKey;

thread_local! {
    static BASE_DIRECTORY: RefCell<Option<AbsolutePathBuf>> = const { RefCell::new(None) };
    static HOME_DIRECTORY: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Resolves relative paths against `base_directory` while `operation` runs.
///
/// [`AbsolutePathBuf`] deserialization needs this scope: without it a relative path has no
/// meaning and fails. The scope is thread-local, so `operation` must complete on the calling
/// thread and must not park on another thread's work.
pub fn with_base_directory<T>(
    base_directory: &AbsolutePathBuf,
    operation: impl FnOnce() -> T,
) -> T {
    let previous = BASE_DIRECTORY.with(|cell| cell.replace(Some(base_directory.clone())));
    let _restore = Restore(&BASE_DIRECTORY, previous);
    operation()
}

/// Expands a leading `~` against `home_directory` instead of the operating-system home while
/// `operation` runs, under the same thread-local rule as [`with_base_directory`].
pub fn with_home_directory<T>(home_directory: &Path, operation: impl FnOnce() -> T) -> T {
    let previous = HOME_DIRECTORY.with(|cell| cell.replace(Some(home_directory.to_path_buf())));
    let _restore = Restore(&HOME_DIRECTORY, previous);
    operation()
}

/// Rewrites `~` and `~/rest` to the active home directory. Every other spelling, including
/// `~user`, is returned unchanged.
pub(crate) fn expand_home_directory(path: &Path) -> Cow<'_, Path> {
    const SEPARATORS: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };

    let Some(rest) = path.to_str().and_then(|path| path.strip_prefix('~')) else {
        return Cow::Borrowed(path);
    };
    let Some(home) = HOME_DIRECTORY
        .with(|cell| cell.borrow().clone())
        .or_else(dirs::home_dir)
    else {
        return Cow::Borrowed(path);
    };
    if rest.is_empty() {
        return Cow::Owned(home);
    }
    match rest.strip_prefix(SEPARATORS) {
        Some(rest) => Cow::Owned(home.join(rest.trim_start_matches(SEPARATORS))),
        None => Cow::Borrowed(path),
    }
}

impl<'de> Deserialize<'de> for AbsolutePathBuf {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let path = PathBuf::deserialize(deserializer)?;
        match BASE_DIRECTORY.with(|cell| cell.borrow().clone()) {
            Some(base_directory) => Ok(Self::resolve_against_base(path, &base_directory)),
            None => Self::from_absolute(&path).map_err(|_| {
                D::Error::custom(format!(
                    "path must be absolute outside with_base_directory: {}",
                    path.display()
                ))
            }),
        }
    }
}

/// Restores the value a scope replaced, so nested scopes unwind to their caller's context
/// rather than to no context at all.
struct Restore<T: 'static>(&'static LocalKey<RefCell<Option<T>>>, Option<T>);

impl<T: 'static> Drop for Restore<T> {
    fn drop(&mut self) {
        self.0.with(|cell| *cell.borrow_mut() = self.1.take());
    }
}
