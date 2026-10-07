//! An absolute, lexically normalized path value with a string wire form.

mod absolutize;
mod resolution;

pub use resolution::with_base_directory;
pub use resolution::with_home_directory;

use schemars::JsonSchema;
use serde::Serialize;
use std::io;
use std::ops::Deref;
use std::path::Path;
use std::path::PathBuf;
use ts_rs::TS;

/// A path that is absolute and free of `.` and `..` segments.
///
/// Normalization is lexical, so the value may name a path that does not exist and keeps the
/// symlinks and platform aliases the caller supplied. Use [`AbsolutePathBuf::canonicalize`] to
/// collapse those against the filesystem, and `ash-utils-path` for containment and comparison
/// once a real host path is required.
///
/// Ordering and hashing compare the normalized spelling, not the filesystem object.
#[derive(Clone, Debug, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct AbsolutePathBuf(PathBuf);

impl AbsolutePathBuf {
    /// Accepts an already absolute path, after expanding a leading `~`.
    ///
    /// Returns [`io::ErrorKind::InvalidInput`] for every other spelling. The filesystem is never
    /// read, so a missing path still succeeds.
    pub fn from_absolute(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let prepared = prepare(path);
        if !prepared.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("path is not absolute: {}", path.display()),
            ));
        }
        Ok(Self(absolutize::normalize(&prepared)))
    }

    /// Anchors any path spelling to `base_directory`.
    ///
    /// This cannot fail: an absolute `path` ignores the base, and every other spelling inherits
    /// absoluteness from the base.
    pub fn resolve_against_base(path: impl AsRef<Path>, base_directory: &Self) -> Self {
        Self(absolutize::absolutize_from(
            &prepare(path.as_ref()),
            &base_directory.0,
        ))
    }

    /// Anchors any path spelling to the process working directory.
    ///
    /// The working directory is read only when `path` needs it, so an absolute `path` still
    /// resolves after the working directory has been removed.
    pub fn resolve_against_current_dir(path: impl AsRef<Path>) -> io::Result<Self> {
        let prepared = prepare(path.as_ref());
        if prepared.is_absolute() {
            return Ok(Self(absolutize::normalize(&prepared)));
        }
        Ok(Self(absolutize::absolutize_from(
            &prepared,
            &Self::current_dir()?.0,
        )))
    }

    /// Returns the process working directory.
    pub fn current_dir() -> io::Result<Self> {
        Self::from_absolute(std::env::current_dir()?)
    }

    /// Anchors `path` to this directory, replacing it entirely when `path` is absolute.
    pub fn join(&self, path: impl AsRef<Path>) -> Self {
        Self::resolve_against_base(path, self)
    }

    /// Resolves symlinks and platform aliases against the filesystem.
    ///
    /// Fails when the path does not exist. Windows results keep their ordinary drive or UNC
    /// spelling instead of the verbatim `\\?\` form.
    pub fn canonicalize(&self) -> io::Result<Self> {
        dunce::canonicalize(&self.0).map(Self)
    }

    /// Returns the containing directory, or `None` at the filesystem root.
    pub fn parent(&self) -> Option<Self> {
        self.0.parent().map(|parent| Self(parent.to_path_buf()))
    }

    /// Iterates from this path up to and including the filesystem root.
    pub fn ancestors(&self) -> impl Iterator<Item = Self> + '_ {
        self.0
            .ancestors()
            .map(|ancestor| Self(ancestor.to_path_buf()))
    }

    /// Borrows the normalized path.
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// Consumes the value and returns the normalized path, dropping the absoluteness guarantee.
    pub fn into_path_buf(self) -> PathBuf {
        self.0
    }
}

/// Applies the host's own spelling rules before absoluteness is decided: `~` becomes the home
/// directory, and a Windows verbatim prefix becomes the ordinary drive or UNC path it aliases.
fn prepare(path: &Path) -> PathBuf {
    let expanded = resolution::expand_home_directory(path);
    dunce::simplified(&expanded).to_path_buf()
}

impl AsRef<Path> for AbsolutePathBuf {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Deref for AbsolutePathBuf {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<AbsolutePathBuf> for PathBuf {
    fn from(path: AbsolutePathBuf) -> Self {
        path.into_path_buf()
    }
}

impl TryFrom<&Path> for AbsolutePathBuf {
    type Error = io::Error;

    fn try_from(value: &Path) -> Result<Self, Self::Error> {
        Self::from_absolute(value)
    }
}

impl TryFrom<PathBuf> for AbsolutePathBuf {
    type Error = io::Error;

    fn try_from(value: PathBuf) -> Result<Self, Self::Error> {
        Self::from_absolute(value)
    }
}

impl TryFrom<&str> for AbsolutePathBuf {
    type Error = io::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_absolute(value)
    }
}

impl TryFrom<String> for AbsolutePathBuf {
    type Error = io::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_absolute(value)
    }
}

#[cfg(test)]
#[path = "absolute_path_tests.rs"]
mod tests;
