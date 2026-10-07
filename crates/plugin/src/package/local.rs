use crate::manifest::PluginManifest;
use crate::package::digest::ScannedEntryKind;
use crate::package::digest::scan_and_digest;
use crate::{
    PluginError, PluginErrorKind, PluginPackageDigest, PluginPackageId, PluginPath, PluginVersion,
};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Provenance of one validated Plugin package.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginPackageSource {
    BuiltIn,
    LocalDevelopment { canonical_path: PathBuf },
}

/// Normalized digest algorithm used to identify one exact package payload.
///
/// Local development keeps the historical Ash algorithm for existing object-store compatibility.
/// Product-independent Marketplace distributions explicitly select `MarketplaceV1`; the selected
/// algorithm is preserved while Plugin authority copies and revalidates the package.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginPackageDigestAlgorithm {
    LegacyAshV1,
    MarketplaceV1,
}

impl PluginPackageDigestAlgorithm {
    pub(super) const fn domain(self) -> &'static [u8] {
        match self {
            Self::LegacyAshV1 => b"ash-plugin-package-v1\0",
            Self::MarketplaceV1 => b"marketplace-package-v1\0",
        }
    }
}

/// Bounded file statistics captured while computing a local package digest.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PackageFileStats {
    pub file_count: u64,
    pub total_bytes: u64,
}

/// Validated observation of one explicit local-development Plugin package.
///
/// The canonical path is diagnostic provenance, not an immutable object root. Consumers that need
/// stable runtime bytes must copy the package into the content-addressed store introduced by PL1
/// and revalidate it there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalPluginPackage {
    source: PluginPackageSource,
    manifest: PluginManifest,
    package_digest: PluginPackageDigest,
    manifest_digest: PluginPackageDigest,
    stats: PackageFileStats,
    digest_algorithm: PluginPackageDigestAlgorithm,
}

impl LocalPluginPackage {
    /// Loads one exact package root; this method never searches parent directories.
    pub fn load(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        Self::load_with_digest_algorithm(root, PluginPackageDigestAlgorithm::LegacyAshV1)
    }

    /// Loads a package using the digest algorithm selected by its distribution protocol.
    pub fn load_with_digest_algorithm(
        root: impl AsRef<Path>,
        digest_algorithm: PluginPackageDigestAlgorithm,
    ) -> Result<Self, PluginError> {
        let root = validate_root(root.as_ref())?;
        let scanned = scan_and_digest(&root, digest_algorithm)?;
        let manifest = PluginManifest::from_json(&scanned.manifest_bytes)?;
        validate_contribution_paths(&root, &manifest, &scanned.entries)?;
        Ok(Self {
            source: PluginPackageSource::LocalDevelopment {
                canonical_path: root,
            },
            manifest,
            package_digest: scanned.digest,
            manifest_digest: PluginPackageDigest::sha256(&scanned.manifest_bytes),
            stats: scanned.stats,
            digest_algorithm,
        })
    }

    pub fn digest_algorithm(&self) -> PluginPackageDigestAlgorithm {
        self.digest_algorithm
    }

    pub fn source(&self) -> &PluginPackageSource {
        &self.source
    }

    pub fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    pub fn package_digest(&self) -> &PluginPackageDigest {
        &self.package_digest
    }

    pub fn manifest_digest(&self) -> &PluginPackageDigest {
        &self.manifest_digest
    }

    pub fn stats(&self) -> PackageFileStats {
        self.stats
    }
}

/// Read-only projection discovered from one explicit local Plugin source directory.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LocalPluginCatalog {
    packages: Vec<LocalPluginPackage>,
}

impl LocalPluginCatalog {
    /// Discovers either the source directory itself, when it is a package, or its immediate
    /// package children. Unrelated child directories are ignored.
    pub fn discover(source_directory: impl AsRef<Path>) -> Result<Self, PluginError> {
        let source_directory = validate_root(source_directory.as_ref())?;
        let own_marker = source_directory.join(".ash-plugin");
        let candidates = if marker_exists(&own_marker)? {
            vec![source_directory]
        } else {
            discover_children(&source_directory)?
        };

        let mut packages = candidates
            .into_iter()
            .map(LocalPluginPackage::load)
            .collect::<Result<Vec<_>, _>>()?;
        packages.sort_by(|left, right| {
            (
                &left.manifest.id,
                &left.manifest.version,
                &left.package_digest,
            )
                .cmp(&(
                    &right.manifest.id,
                    &right.manifest.version,
                    &right.package_digest,
                ))
        });
        reject_duplicate_exact_versions(&packages)?;
        Ok(Self { packages })
    }

    pub fn list(&self) -> &[LocalPluginPackage] {
        &self.packages
    }

    pub fn read(
        &self,
        id: &PluginPackageId,
        version: &PluginVersion,
    ) -> Option<&LocalPluginPackage> {
        self.packages
            .iter()
            .find(|package| &package.manifest.id == id && &package.manifest.version == version)
    }
}

fn validate_root(root: &Path) -> Result<PathBuf, PluginError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| {
        PluginError::new(
            PluginErrorKind::SourceUnavailable,
            "local Plugin source does not exist or cannot be inspected",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PluginError::new(
            PluginErrorKind::PackageUnsafe,
            "local Plugin source root must be a real directory, not a link",
        ));
    }
    root.canonicalize().map_err(|_| {
        PluginError::new(
            PluginErrorKind::SourceUnavailable,
            "local Plugin source cannot be canonicalized",
        )
    })
}

fn discover_children(source_directory: &Path) -> Result<Vec<PathBuf>, PluginError> {
    let mut entries: Vec<_> = fs::read_dir(source_directory)
        .map_err(|_| {
            PluginError::new(
                PluginErrorKind::SourceUnavailable,
                "local Plugin discovery directory cannot be read",
            )
        })?
        .collect::<Result<_, _>>()
        .map_err(|_| {
            PluginError::new(
                PluginErrorKind::SourceUnavailable,
                "local Plugin discovery directory cannot be read",
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut candidates = Vec::new();
    for entry in entries {
        let path = entry.path();
        if marker_exists(&path.join(".ash-plugin"))? {
            candidates.push(path);
        }
    }
    Ok(candidates)
}

fn marker_exists(marker: &Path) -> Result<bool, PluginError> {
    match fs::symlink_metadata(marker) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(PluginError::new(
            PluginErrorKind::SourceUnavailable,
            "local Plugin marker cannot be inspected",
        )),
    }
}

fn validate_contribution_paths(
    root: &Path,
    manifest: &PluginManifest,
    entries: &std::collections::BTreeMap<PluginPath, ScannedEntryKind>,
) -> Result<(), PluginError> {
    let mut locations = BTreeSet::new();
    for skill in &manifest.contributions.skills {
        require_entry(entries, &skill.path, ScannedEntryKind::Directory, "Skill")?;
        require_contained(root, &skill.path)?;
        let skill_manifest =
            PluginPath::new(format!("{}/SKILL.md", skill.path)).map_err(|error| {
                contribution_invalid(format!(
                    "Skill '{}' has an invalid SKILL.md path: {error}",
                    skill.id
                ))
            })?;
        require_entry(
            entries,
            &skill_manifest,
            ScannedEntryKind::File,
            "Skill manifest",
        )?;
        unique_location(&mut locations, &skill.path, "Skill")?;
    }
    for server in &manifest.contributions.mcp_servers {
        require_entry(
            entries,
            &server.definition,
            ScannedEntryKind::File,
            "MCP definition",
        )?;
        require_contained(root, &server.definition)?;
        unique_location(&mut locations, &server.definition, "MCP server")?;
    }
    for extension in &manifest.contributions.editor_extensions {
        require_entry(
            entries,
            &extension.entrypoint,
            ScannedEntryKind::File,
            "Editor Extension entrypoint",
        )?;
        require_contained(root, &extension.entrypoint)?;
        unique_location(&mut locations, &extension.entrypoint, "Editor Extension")?;
    }
    for extension in &manifest.contributions.declarative_extensions {
        require_entry(
            entries,
            &extension.path,
            ScannedEntryKind::Directory,
            "declarative Extension",
        )?;
        require_contained(root, &extension.path)?;
        let extension_manifest = PluginPath::new(format!("{}/package.json", extension.path))
            .map_err(|error| {
                contribution_invalid(format!(
                    "declarative Extension '{}' has an invalid package.json path: {error}",
                    extension.id
                ))
            })?;
        require_entry(
            entries,
            &extension_manifest,
            ScannedEntryKind::File,
            "declarative Extension manifest",
        )?;
        unique_location(&mut locations, &extension.path, "declarative Extension")?;
    }
    for asset in &manifest.contributions.assets {
        if !entries.contains_key(&asset.path) {
            return Err(contribution_invalid(format!(
                "asset path '{}' does not exist",
                asset.path
            )));
        }
        require_contained(root, &asset.path)?;
        unique_location(&mut locations, &asset.path, "asset")?;
    }
    for permission in &manifest.permissions {
        if let crate::Permission::Process { executable } = permission {
            require_entry(
                entries,
                executable,
                ScannedEntryKind::File,
                "process executable",
            )?;
            require_contained(root, executable)?;
        }
    }
    Ok(())
}

fn require_entry(
    entries: &std::collections::BTreeMap<PluginPath, ScannedEntryKind>,
    path: &PluginPath,
    expected: ScannedEntryKind,
    label: &str,
) -> Result<(), PluginError> {
    if entries.get(path) != Some(&expected) {
        return Err(contribution_invalid(format!(
            "{label} path '{path}' does not exist with the required file type"
        )));
    }
    Ok(())
}

fn require_contained(root: &Path, relative: &PluginPath) -> Result<(), PluginError> {
    let candidate = root.join(relative.to_platform_path());
    let canonical = candidate.canonicalize().map_err(|_| {
        contribution_invalid(format!(
            "contribution path '{relative}' cannot be canonicalized"
        ))
    })?;
    if !canonical.starts_with(root) {
        return Err(PluginError::new(
            PluginErrorKind::PackageUnsafe,
            format!("contribution path '{relative}' escapes the package root"),
        ));
    }
    let metadata = fs::symlink_metadata(candidate).map_err(|_| {
        contribution_invalid(format!(
            "contribution path '{relative}' cannot be inspected"
        ))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(PluginError::new(
            PluginErrorKind::PackageUnsafe,
            format!("contribution path '{relative}' is a symbolic link"),
        ));
    }
    Ok(())
}

fn unique_location(
    locations: &mut BTreeSet<PluginPath>,
    path: &PluginPath,
    label: &str,
) -> Result<(), PluginError> {
    if !locations.insert(path.clone()) {
        return Err(contribution_invalid(format!(
            "{label} path '{path}' is declared by more than one contribution"
        )));
    }
    Ok(())
}

fn reject_duplicate_exact_versions(packages: &[LocalPluginPackage]) -> Result<(), PluginError> {
    for pair in packages.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        if left.manifest.id == right.manifest.id && left.manifest.version == right.manifest.version
        {
            return Err(PluginError::new(
                PluginErrorKind::PackageConflict,
                format!(
                    "local discovery found more than one package for {} {}",
                    left.manifest.id, left.manifest.version
                ),
            ));
        }
    }
    Ok(())
}

fn contribution_invalid(message: impl Into<String>) -> PluginError {
    PluginError::new(PluginErrorKind::ContributionInvalid, message)
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
