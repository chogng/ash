use crate::DirId;
use crate::EnvId;
use ash_environment::Directory;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::Path;
use std::path::PathBuf;

pub use ash_environment::DirPathError;

/// Directory identity and scope, established by its execution environment's file driver.
/// This value grants no permissions.
#[derive(Clone, Debug)]
pub struct Dir {
    directory: Directory,
}

impl Dir {
    pub fn from_directory(directory: Directory) -> Self {
        Self { directory }
    }

    pub fn open_local(path: impl AsRef<Path>) -> Result<Self, DirPathError> {
        Directory::open_local(path).map(Self::from_directory)
    }

    pub fn env(&self) -> &EnvId {
        self.directory.env()
    }
    pub fn requested_path(&self) -> &Path {
        self.directory.requested_path()
    }
    pub fn canonical_path(&self) -> &Path {
        self.directory.canonical_path()
    }
    pub fn id(&self) -> DirId {
        DirId::from_directory(
            self.env(),
            self.canonical_path(),
            self.directory.object_identity(),
        )
    }
    pub fn directory(&self) -> &Directory {
        &self.directory
    }
    pub fn resolve_existing(&self, path: impl AsRef<Path>) -> Result<PathBuf, DirPathError> {
        self.directory.resolve_existing(path)
    }
    pub fn resolve_for_write(&self, path: impl AsRef<Path>) -> Result<PathBuf, DirPathError> {
        self.directory.resolve_for_write(path)
    }
    pub fn project_observed_path(&self, path: impl AsRef<Path>) -> Option<PathBuf> {
        self.directory.project_observed_path(path)
    }
    pub fn relative_to_existing_ancestor(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, DirPathError> {
        self.directory.relative_to_existing_ancestor(path)
    }
}

impl PartialEq for Dir {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}
impl Eq for Dir {}
impl Hash for Dir {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id().hash(state);
    }
}

#[cfg(test)]
#[path = "dir_tests.rs"]
mod tests;
