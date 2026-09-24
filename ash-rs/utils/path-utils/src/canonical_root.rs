use std::fmt;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// One existing host-filesystem path used as a canonical containment boundary.
///
/// Callers retain ownership of authorization and symlink policy. This type only
/// canonicalizes paths and verifies host-filesystem identity containment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalPathRoot {
    path: PathBuf,
    comparison_path: PathBuf,
    inspection_path: PathBuf,
}

impl CanonicalPathRoot {
    /// Canonicalizes an existing path for repeated containment checks.
    pub fn new(path: impl AsRef<Path>) -> io::Result<Self> {
        let inspection_path = std::path::absolute(path.as_ref())?;
        let path = inspection_path.canonicalize()?;
        let comparison_path = normalize_canonical_for_comparison(path.clone());
        Ok(Self {
            path,
            comparison_path,
            inspection_path,
        })
    }

    /// Returns the canonical host path represented by this boundary.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Canonicalizes an existing path and verifies that it is within this boundary.
    ///
    /// The boundary itself is considered contained. Symlinks are followed by
    /// canonicalization; callers that prohibit symlinks must enforce that policy
    /// before calling this method.
    pub fn canonicalize_within(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, CanonicalContainmentError> {
        let path = path
            .as_ref()
            .canonicalize()
            .map_err(CanonicalContainmentError::Unavailable)?;
        let comparison_path = normalize_canonical_for_comparison(path.clone());
        if comparison_path.starts_with(&self.comparison_path) {
            Ok(path)
        } else {
            Err(CanonicalContainmentError::OutsideRoot)
        }
    }

    /// Inspects an absolute or current-directory-relative path below this root without following
    /// symbolic links.
    ///
    /// Every existing component from the root through the candidate is inspected with
    /// `symlink_metadata`. Missing components are reported as [`NoSymlinkPathStatus::Missing`].
    /// This is a filesystem fact check only; callers retain ownership of the operation and policy
    /// that consume the result.
    pub fn inspect_without_symlinks(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<NoSymlinkPathStatus, NoSymlinkPathError> {
        let path = std::path::absolute(path.as_ref()).map_err(|source| {
            NoSymlinkPathError::Unavailable {
                path: path.as_ref().to_path_buf(),
                source,
            }
        })?;
        let relative = path
            .strip_prefix(&self.inspection_path)
            .map_err(|_| NoSymlinkPathError::OutsideRoot(path.clone()))?;
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(NoSymlinkPathError::OutsideRoot(path));
        }
        let mut current = self.inspection_path.clone();
        inspect_component(&current)?;
        for component in relative.components() {
            match component {
                Component::Normal(component) => current.push(component),
                Component::CurDir => continue,
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => unreachable!(),
            }
            if inspect_component(&current)? == NoSymlinkPathStatus::Missing {
                return Ok(NoSymlinkPathStatus::Missing);
            }
        }
        Ok(NoSymlinkPathStatus::Existing)
    }
}

/// Whether a path inspected without following symbolic links currently exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoSymlinkPathStatus {
    Existing,
    Missing,
}

/// Failure to inspect a path below a canonical root without following symbolic links.
#[derive(Debug)]
pub enum NoSymlinkPathError {
    OutsideRoot(PathBuf),
    Symlink(PathBuf),
    Unavailable { path: PathBuf, source: io::Error },
}

impl fmt::Display for NoSymlinkPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutsideRoot(path) => {
                write!(
                    formatter,
                    "path is outside the canonical root: {}",
                    path.display()
                )
            }
            Self::Symlink(path) => {
                write!(
                    formatter,
                    "path contains a symbolic link: {}",
                    path.display()
                )
            }
            Self::Unavailable { path, source } => {
                write!(
                    formatter,
                    "path metadata is unavailable for {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for NoSymlinkPathError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unavailable { source, .. } => Some(source),
            Self::OutsideRoot(_) | Self::Symlink(_) => None,
        }
    }
}

fn inspect_component(path: &Path) -> Result<NoSymlinkPathStatus, NoSymlinkPathError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(NoSymlinkPathError::Symlink(path.to_path_buf()))
        }
        Ok(_) => Ok(NoSymlinkPathStatus::Existing),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(NoSymlinkPathStatus::Missing),
        Err(source) => Err(NoSymlinkPathError::Unavailable {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Failure to canonicalize an existing path within a [`CanonicalPathRoot`].
#[derive(Debug)]
pub enum CanonicalContainmentError {
    /// The candidate path could not be canonicalized.
    Unavailable(io::Error),
    /// The canonical candidate is not contained by the canonical root.
    OutsideRoot,
}

impl fmt::Display for CanonicalContainmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(error) => write!(formatter, "path is unavailable: {error}"),
            Self::OutsideRoot => formatter.write_str("path is outside the canonical root"),
        }
    }
}

impl std::error::Error for CanonicalContainmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unavailable(error) => Some(error),
            Self::OutsideRoot => None,
        }
    }
}

fn normalize_canonical_for_comparison(path: PathBuf) -> PathBuf {
    normalize_for_wsl_on(path, is_wsl())
}

fn is_wsl() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WSL_DISTRO_NAME").is_some() {
            return true;
        }
        std::fs::read_to_string("/proc/version")
            .is_ok_and(|version| version.to_lowercase().contains("microsoft"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub(super) fn normalize_for_wsl_on(path: PathBuf, is_wsl: bool) -> PathBuf {
    if !is_wsl || !is_wsl_case_insensitive_path(&path) {
        return path;
    }
    lower_ascii_path(path)
}

fn is_wsl_case_insensitive_path(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;

        let mut components = path.components();
        let Some(Component::RootDir) = components.next() else {
            return false;
        };
        let Some(Component::Normal(mount)) = components.next() else {
            return false;
        };
        let Some(Component::Normal(drive)) = components.next() else {
            return false;
        };
        let drive = drive.as_bytes();
        mount.as_bytes().eq_ignore_ascii_case(b"mnt")
            && drive.len() == 1
            && drive[0].is_ascii_alphabetic()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        false
    }
}

#[cfg(target_os = "linux")]
fn lower_ascii_path(path: PathBuf) -> PathBuf {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::ffi::OsStringExt;

    let lowered = path
        .as_os_str()
        .as_bytes()
        .iter()
        .map(u8::to_ascii_lowercase)
        .collect();
    PathBuf::from(OsString::from_vec(lowered))
}

#[cfg(not(target_os = "linux"))]
fn lower_ascii_path(path: PathBuf) -> PathBuf {
    path
}
