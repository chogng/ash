use crate::InstalledPluginRef;
use crate::LocalPluginPackage;
use crate::PluginError;
use crate::PluginErrorKind;
use crate::PluginPackageDigest;
use crate::PluginPackageSource;
use crate::plugin_package::snapshot::create_stable_local_snapshot_with_observer;
use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::NoSymlinkPathError;
use ash_utils_path::NoSymlinkPathStatus;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

/// Immutable package object selected for one Plugin activation generation.
#[derive(Clone, Debug)]
pub struct InstalledPluginPackage {
    package: LocalPluginPackage,
    object_root: PathBuf,
    object_boundary: CanonicalPathRoot,
}

impl InstalledPluginPackage {
    pub fn manifest(&self) -> &crate::PluginManifest {
        self.package.manifest()
    }

    pub fn package_digest(&self) -> &PluginPackageDigest {
        self.package.package_digest()
    }

    pub fn package(&self) -> &LocalPluginPackage {
        &self.package
    }

    /// Returns the root of this exact immutable package object for trusted runtime composition.
    ///
    /// Launchers may use this path to bind the extension process working directory or a sandbox
    /// mount. Contributions must continue to resolve declared files through [`Self::resolve_file`]
    /// or [`Self::resolve_directory`] and must not use this accessor to bypass path validation.
    pub fn package_root(&self) -> &Path {
        &self.object_root
    }

    /// Resolves one validated regular file inside this immutable object.
    pub fn resolve_file(&self, path: &crate::PluginPath) -> Result<PathBuf, PluginError> {
        let candidate = self.object_root.join(path.to_platform_path());
        require_existing_store_path(&self.object_boundary, &candidate)?;
        let canonical = candidate.canonicalize().map_err(store_io)?;
        if !canonical.starts_with(&self.object_root)
            || !fs::symlink_metadata(&candidate)
                .map_err(store_io)?
                .is_file()
        {
            return Err(PluginError::new(
                PluginErrorKind::PackageUnsafe,
                "installed Plugin file escaped its immutable object",
            ));
        }
        Ok(canonical)
    }

    /// Resolves one validated directory inside this immutable object.
    pub fn resolve_directory(&self, path: &crate::PluginPath) -> Result<PathBuf, PluginError> {
        let candidate = self.object_root.join(path.to_platform_path());
        require_existing_store_path(&self.object_boundary, &candidate)?;
        let canonical = candidate.canonicalize().map_err(store_io)?;
        if !canonical.starts_with(&self.object_root)
            || !fs::symlink_metadata(&candidate).map_err(store_io)?.is_dir()
        {
            return Err(PluginError::new(
                PluginErrorKind::PackageUnsafe,
                "installed Plugin directory escaped its immutable object",
            ));
        }
        Ok(canonical)
    }

    /// Reads one bounded UTF-8 definition file from this immutable object.
    pub fn read_utf8_file(
        &self,
        path: &crate::PluginPath,
        maximum_bytes: u64,
    ) -> Result<String, PluginError> {
        let file = self.resolve_file(path)?;
        let metadata = fs::metadata(&file).map_err(store_io)?;
        if metadata.len() > maximum_bytes {
            return Err(PluginError::new(
                PluginErrorKind::ContributionInvalid,
                "installed Plugin definition exceeds its size limit",
            ));
        }
        fs::read_to_string(file).map_err(|_| {
            PluginError::new(
                PluginErrorKind::ContributionInvalid,
                "installed Plugin definition is not valid UTF-8",
            )
        })
    }
}

/// Immutable content-addressed store for validated local Plugin packages.
///
/// Installation copies into a unique staging directory, validates the copy, and then atomically
/// promotes it. It does not enable contributions, grant permissions, or start a runtime.
#[derive(Clone, Debug)]
pub struct PluginPackageStore {
    root: PathBuf,
    boundary: CanonicalPathRoot,
}

impl PluginPackageStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        let requested_root = std::path::absolute(root.as_ref()).map_err(store_io)?;
        fs::create_dir_all(&requested_root).map_err(store_io)?;
        let requested_boundary = CanonicalPathRoot::new(&requested_root).map_err(store_io)?;
        require_existing_store_path(&requested_boundary, &requested_root)?;
        let root = requested_boundary.path().to_path_buf();
        let boundary = CanonicalPathRoot::new(&root).map_err(store_io)?;
        ensure_store_directory(&boundary, &root.join("objects"))?;
        ensure_store_directory(&boundary, &root.join("staging"))?;
        sync_directory(&root)?;
        Ok(Self { root, boundary })
    }

    /// Removes only transient staging leftovers from an interrupted installation.
    ///
    /// The object store deliberately retains unreferenced immutable packages: a caller may have
    /// installed a package into the store immediately before opening the authority and still be
    /// preparing its durable Install command.
    pub(crate) fn recover_orphans(&self) -> Result<(), PluginError> {
        let staging = self.root.join("staging");
        require_existing_store_path(&self.boundary, &staging)?;
        for entry in fs::read_dir(&staging).map_err(store_io)? {
            let entry = entry.map_err(store_io)?;
            let metadata = entry.file_type().map_err(store_io)?;
            if metadata.is_dir() {
                require_existing_store_path(&self.boundary, &entry.path())?;
                fs::remove_dir_all(entry.path()).map_err(store_io)?;
            } else {
                return Err(PluginError::new(
                    PluginErrorKind::PackageUnsafe,
                    "Plugin staging contains a non-directory orphan",
                ));
            }
        }
        sync_directory(&staging)?;
        sync_directory(&self.root)
    }

    pub fn install_local(
        &self,
        package: &LocalPluginPackage,
    ) -> Result<InstalledPluginRef, PluginError> {
        self.install_local_with_snapshot_observer(package, |_, _| {})
    }

    fn install_local_with_snapshot_observer(
        &self,
        package: &LocalPluginPackage,
        mut after_snapshot: impl FnMut(usize, &Path),
    ) -> Result<InstalledPluginRef, PluginError> {
        let PluginPackageSource::LocalDevelopment { canonical_path } = package.source() else {
            return Err(PluginError::new(
                PluginErrorKind::SourceUnavailable,
                "built-in Plugin installation is owned by the Ash release",
            ));
        };
        let operation_id = new_operation_id()?;
        let staging = self.root.join("staging").join(&operation_id);
        let result = (|| {
            require_existing_store_path(&self.boundary, &self.root.join("staging"))?;
            let installed = create_stable_local_snapshot_with_observer(
                package,
                canonical_path,
                &staging,
                &mut after_snapshot,
            )?;
            let object = self.object_path(installed.package_digest());
            match inspect_store_path(&self.boundary, &object)? {
                NoSymlinkPathStatus::Existing => validate_object(&object, &installed)?,
                NoSymlinkPathStatus::Missing => {
                    sync_directory_tree(&staging)?;
                    if let Err(error) = fs::rename(&staging, &object) {
                        match inspect_store_path(&self.boundary, &object)? {
                            NoSymlinkPathStatus::Existing => {}
                            NoSymlinkPathStatus::Missing => return Err(store_io(error)),
                        }
                    }
                    require_existing_store_path(&self.boundary, &object)?;
                    if !fs::symlink_metadata(&object).map_err(store_io)?.is_dir() {
                        return Err(unsafe_store_path());
                    }
                    validate_object(&object, &installed)?;
                    sync_directory(&self.root.join("objects"))?;
                }
            }
            Ok(InstalledPluginRef {
                id: installed.manifest().id.clone(),
                version: installed.manifest().version.clone(),
                digest: installed.package_digest().clone(),
            })
        })();
        if inspect_store_path(&self.boundary, &staging).ok() == Some(NoSymlinkPathStatus::Existing)
        {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn read(&self, installed: &InstalledPluginRef) -> Result<LocalPluginPackage, PluginError> {
        let root = self.object_path(&installed.digest);
        if inspect_store_path(&self.boundary, &root)? == NoSymlinkPathStatus::Missing {
            return Err(PluginError::new(
                PluginErrorKind::PackageConflict,
                "installed Plugin object does not match its recorded digest",
            ));
        }
        let package = [
            crate::PluginPackageDigestAlgorithm::LegacyAshV1,
            crate::PluginPackageDigestAlgorithm::MarketplaceV1,
        ]
        .into_iter()
        .find_map(|algorithm| {
            LocalPluginPackage::load_with_digest_algorithm(&root, algorithm)
                .ok()
                .filter(|package| package.package_digest() == &installed.digest)
        })
        .ok_or_else(|| {
            PluginError::new(
                PluginErrorKind::PackageConflict,
                "installed Plugin object does not match its recorded digest",
            )
        })?;
        if package.manifest().id != installed.id
            || package.manifest().version != installed.version
            || package.package_digest() != &installed.digest
        {
            return Err(PluginError::new(
                PluginErrorKind::PackageConflict,
                "installed Plugin reference does not match immutable object content",
            ));
        }
        Ok(package)
    }

    /// Loads one exact immutable package object for activation consumers.
    pub fn activate(
        &self,
        installed: &InstalledPluginRef,
    ) -> Result<InstalledPluginPackage, PluginError> {
        let package = self.read(installed)?;
        let object_root = self.object_path(&installed.digest);
        let object_boundary = CanonicalPathRoot::new(&object_root).map_err(store_io)?;
        Ok(InstalledPluginPackage {
            package,
            object_root,
            object_boundary,
        })
    }

    /// Removes one exact immutable object after its authority reference has been removed.
    pub(crate) fn remove_object(&self, digest: &PluginPackageDigest) -> Result<(), PluginError> {
        let object = self.object_path(digest);
        match inspect_store_path(&self.boundary, &object)? {
            NoSymlinkPathStatus::Existing
                if fs::symlink_metadata(&object).map_err(store_io)?.is_dir() =>
            {
                fs::remove_dir_all(&object).map_err(store_io)?;
                sync_directory(&self.root.join("objects"))
            }
            NoSymlinkPathStatus::Existing => Err(PluginError::new(
                PluginErrorKind::PackageUnsafe,
                "Plugin object path is not a regular directory",
            )),
            NoSymlinkPathStatus::Missing => Ok(()),
        }
    }

    fn object_path(&self, digest: &PluginPackageDigest) -> PathBuf {
        self.root.join("objects").join(
            digest
                .as_str()
                .strip_prefix("sha256:")
                .expect("validated digest has a SHA-256 prefix"),
        )
    }
}

fn inspect_store_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<NoSymlinkPathStatus, PluginError> {
    boundary
        .inspect_without_symlinks(path)
        .map_err(|error| match error {
            NoSymlinkPathError::Unavailable { source, .. } => store_io(source),
            NoSymlinkPathError::OutsideRoot(_) | NoSymlinkPathError::Symlink(_) => {
                unsafe_store_path()
            }
        })
}

fn require_existing_store_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), PluginError> {
    if inspect_store_path(boundary, path)? != NoSymlinkPathStatus::Existing {
        return Err(unsafe_store_path());
    }
    Ok(())
}

fn ensure_store_directory(boundary: &CanonicalPathRoot, path: &Path) -> Result<(), PluginError> {
    if inspect_store_path(boundary, path)? == NoSymlinkPathStatus::Missing {
        fs::create_dir_all(path).map_err(store_io)?;
    }
    require_existing_store_path(boundary, path)?;
    if !fs::symlink_metadata(path).map_err(store_io)?.is_dir() {
        return Err(unsafe_store_path());
    }
    Ok(())
}

fn unsafe_store_path() -> PluginError {
    PluginError::new(
        PluginErrorKind::PackageUnsafe,
        "Plugin package store path contains a symbolic link",
    )
}

fn validate_object(object: &Path, snapshot: &LocalPluginPackage) -> Result<(), PluginError> {
    let existing =
        LocalPluginPackage::load_with_digest_algorithm(object, snapshot.digest_algorithm())?;
    if existing.package_digest() != snapshot.package_digest()
        || existing.manifest().id != snapshot.manifest().id
        || existing.manifest().version != snapshot.manifest().version
    {
        return Err(PluginError::new(
            PluginErrorKind::PackageConflict,
            "Plugin object path contains different content",
        ));
    }
    Ok(())
}

fn new_operation_id() -> Result<String, PluginError> {
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| {
        PluginError::new(
            PluginErrorKind::SourceUnavailable,
            "Plugin staging identity could not be generated",
        )
    })?;
    let mut value = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

fn sync_directory_tree(path: &Path) -> Result<(), PluginError> {
    let mut entries = fs::read_dir(path)
        .map_err(store_io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_io)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry.file_type().map_err(store_io)?.is_dir() {
            sync_directory_tree(&entry.path())?;
        }
    }
    sync_directory(path)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), PluginError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(store_io)?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), PluginError> {
    Ok(())
}

fn store_io(_: impl std::fmt::Display) -> PluginError {
    PluginError::new(
        PluginErrorKind::SourceUnavailable,
        "Plugin package store operation failed",
    )
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
