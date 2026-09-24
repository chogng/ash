use std::error::Error;
use std::fmt;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use super::SystemServiceError;

const RESOURCE_SERVICE: &str = "application resources";

/// Validated relative path beneath an application resource root.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResourcePath(PathBuf);

impl ResourcePath {
    /// Creates a non-empty relative resource path without parent traversal.
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, ResourcePathError> {
        let path = path.into();
        if path.as_os_str().is_empty() {
            return Err(ResourcePathError::Empty);
        }
        for component in path.components() {
            match component {
                Component::Normal(_) => {}
                Component::CurDir => return Err(ResourcePathError::CurrentDirectory),
                Component::ParentDir => return Err(ResourcePathError::ParentTraversal),
                Component::RootDir | Component::Prefix(_) => {
                    return Err(ResourcePathError::Absolute);
                }
            }
        }
        Ok(Self(path))
    }

    /// Returns the validated relative path.
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// Invalid application resource path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourcePathError {
    Empty,
    Absolute,
    CurrentDirectory,
    ParentTraversal,
}

impl fmt::Display for ResourcePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("resource path cannot be empty"),
            Self::Absolute => formatter.write_str("resource path must be relative"),
            Self::CurrentDirectory => {
                formatter.write_str("resource path cannot contain current-directory components")
            }
            Self::ParentTraversal => {
                formatter.write_str("resource path cannot escape its resource root")
            }
        }
    }
}

impl Error for ResourcePathError {}

/// Backend used to locate immutable files shipped with an application.
pub trait ResourceService: Send + Sync {
    /// Returns the root directory selected for packaged resources.
    fn root(&self) -> Result<PathBuf, SystemServiceError>;

    /// Resolves a validated path beneath the resource root.
    fn resolve(&self, path: &ResourcePath) -> Result<PathBuf, SystemServiceError> {
        Ok(self.root()?.join(path.as_path()))
    }

    /// Reads one packaged resource into memory.
    fn read(&self, path: &ResourcePath) -> Result<Vec<u8>, SystemServiceError> {
        std::fs::read(self.resolve(path)?)
            .map_err(|source| SystemServiceError::backend(RESOURCE_SERVICE, source))
    }
}

/// Cloneable application-wide capability for packaged resource lookup.
#[derive(Clone)]
pub struct ResourceHandle {
    service: Arc<dyn ResourceService>,
}

impl ResourceHandle {
    pub(crate) fn new(service: impl ResourceService + 'static) -> Self {
        Self {
            service: Arc::new(service),
        }
    }

    /// Returns the packaged resource root.
    pub fn root(&self) -> Result<PathBuf, SystemServiceError> {
        self.service.root()
    }

    /// Resolves a validated resource path.
    pub fn resolve(&self, path: &ResourcePath) -> Result<PathBuf, SystemServiceError> {
        self.service.resolve(path)
    }

    /// Reads one packaged resource.
    pub fn read(&self, path: &ResourcePath) -> Result<Vec<u8>, SystemServiceError> {
        self.service.read(path)
    }
}

/// Default resource locator derived from the current executable's installation layout.
#[derive(Clone, Debug)]
pub struct SystemResourceLocator {
    root: PathBuf,
}

impl SystemResourceLocator {
    /// Discovers the conventional resource root beside the current executable or app bundle.
    pub fn discover() -> Result<Self, SystemServiceError> {
        let executable = std::env::current_exe()
            .map_err(|source| SystemServiceError::backend(RESOURCE_SERVICE, source))?;
        Ok(Self {
            root: resource_root_for_executable(&executable),
        })
    }

    /// Uses an explicit root, primarily for development hosts and tests.
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Default for SystemResourceLocator {
    fn default() -> Self {
        Self::discover().unwrap_or_else(|_| Self::from_root("resources"))
    }
}

impl ResourceService for SystemResourceLocator {
    fn root(&self) -> Result<PathBuf, SystemServiceError> {
        Ok(self.root.clone())
    }
}

fn resource_root_for_executable(executable: &Path) -> PathBuf {
    let executable_dir = executable.parent().unwrap_or_else(|| Path::new("."));
    #[cfg(target_os = "macos")]
    if executable_dir
        .file_name()
        .is_some_and(|name| name == "MacOS")
        && let Some(contents) = executable_dir.parent()
    {
        return contents.join("Resources");
    }
    executable_dir.join("resources")
}

#[cfg(test)]
#[path = "resource_tests.rs"]
mod tests;
