use crate::ContentDigest;
use crate::SkillCatalog;
use crate::SkillError;
use crate::SkillErrorKind;
use crate::file_snapshot::FileSnapshotFailure;
use crate::file_snapshot::read_verified_file_snapshot;
use ash_protocol::SkillRef;
use ash_protocol::SkillVersionSelector;
use std::ffi::OsStr;
use std::fs;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

const MAX_RESOURCE_PATH_BYTES: usize = 1024;
const MAX_RESOURCE_FILE_BYTES: u64 = 256 * 1024;

/// Validated path relative to one Skill package root.
///
/// Callers may address any regular package file. The top-level directory communicates how the
/// file is intended to be consumed; it does not select a different resolver or grant authority.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SkillResourcePath(PathBuf);

impl SkillResourcePath {
    pub fn new(value: impl AsRef<Path>) -> Result<Self, SkillError> {
        let value = value.as_ref();
        if value.as_os_str().is_empty()
            || value.as_os_str().as_encoded_bytes().len() > MAX_RESOURCE_PATH_BYTES
            || value
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(invalid_resource_path());
        }
        Ok(Self(value.to_path_buf()))
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn display(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    pub fn kind(&self) -> SkillResourceKind {
        let mut components = self.0.components();
        let Some(Component::Normal(first)) = components.next() else {
            return SkillResourceKind::Other;
        };
        if components.next().is_none() && first == OsStr::new("SKILL.md") {
            return SkillResourceKind::Instructions;
        }
        match first.to_str() {
            Some("references") => SkillResourceKind::Reference,
            Some("scripts") => SkillResourceKind::Script,
            Some("assets") => SkillResourceKind::Asset,
            Some("agents") => SkillResourceKind::AgentMetadata,
            _ => SkillResourceKind::Other,
        }
    }
}

/// Conventional role of a file inside a Skill package.
///
/// The role helps consumers choose whether to place text in context, execute through the ordinary
/// Tool system, or hand a file to an artifact pipeline. It never changes path validation or grants
/// permission to read, execute, or publish the file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillResourceKind {
    Instructions,
    Reference,
    Script,
    Asset,
    AgentMetadata,
    Other,
}

impl SkillResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Reference => "reference",
            Self::Script => "script",
            Self::Asset => "asset",
            Self::AgentMetadata => "agent-metadata",
            Self::Other => "other",
        }
    }
}

/// Exact bounded bytes read from a digest-pinned Skill package.
///
/// The resource digest covers the returned file. The Skill digest separately proves which
/// `SKILL.md` instructions authorized the read; it does not claim that every sibling file is part
/// of the `SKILL.md` digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillResource {
    path: SkillResourcePath,
    content_digest: ContentDigest,
    bytes: Vec<u8>,
}

impl SkillResource {
    pub fn path(&self) -> &SkillResourcePath {
        &self.path
    }

    pub fn kind(&self) -> SkillResourceKind {
        self.path.kind()
    }

    pub fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl SkillCatalog {
    /// Reads one bounded package file beneath a Skill pinned to an exact `SKILL.md` digest.
    pub fn read_resource(
        &self,
        selected: &SkillRef,
        path: &SkillResourcePath,
    ) -> Result<SkillResource, SkillError> {
        let entry = self.snapshot.read(&selected.id).ok_or_else(|| {
            SkillError::new(
                SkillErrorKind::SkillNotFound,
                format!(
                    "Skill '{}' is not present in the current catalog",
                    selected.id.name
                ),
            )
        })?;
        let SkillVersionSelector::PinnedDigest { digest } = &selected.version else {
            return Err(SkillError::new(
                SkillErrorKind::InvalidContent,
                format!(
                    "Skill '{}' resource reads require a pinned content digest",
                    selected.id.name
                ),
            ));
        };
        if digest != entry.content_digest() {
            return Err(content_changed(selected.id.name.as_str()));
        }
        let source = self
            .sources
            .iter()
            .find(|source| source.view().id() == &selected.id.source)
            .ok_or_else(|| unavailable(selected.id.name.as_str()))?;
        let candidate = source
            .skill_directory(&selected.id.name)
            .ok_or_else(|| unavailable(selected.id.name.as_str()))?;
        crate::activation::load_exact_body_from_directory(
            source.host_root(),
            &candidate,
            selected.id.name.as_str(),
            entry.content_digest(),
        )?;
        let skill_directory =
            checked_directory(source.host_root(), &candidate, selected.id.name.as_str())?;
        let resource_path =
            checked_resource_path(&skill_directory, path, selected.id.name.as_str())?;
        read_resource_file(resource_path, path.clone(), selected.id.name.as_str())
    }
}

fn checked_directory(
    parent: &Path,
    candidate: &Path,
    skill_name: &str,
) -> Result<PathBuf, SkillError> {
    let metadata = fs::symlink_metadata(candidate).map_err(|_| unavailable(skill_name))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unavailable(skill_name));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| unavailable(skill_name))?;
    if !canonical.starts_with(parent) {
        return Err(unavailable(skill_name));
    }
    Ok(canonical)
}

fn checked_resource_path(
    skill_directory: &Path,
    path: &SkillResourcePath,
    skill_name: &str,
) -> Result<PathBuf, SkillError> {
    let mut current = skill_directory.to_path_buf();
    let components = path.as_path().components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            return Err(invalid_resource_path());
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| unavailable(skill_name))?;
        if metadata.file_type().is_symlink() || (index + 1 < components.len() && !metadata.is_dir())
        {
            return Err(unavailable(skill_name));
        }
    }
    let canonical = current
        .canonicalize()
        .map_err(|_| unavailable(skill_name))?;
    if !canonical.starts_with(skill_directory) {
        return Err(unavailable(skill_name));
    }
    Ok(canonical)
}

fn read_resource_file(
    path: PathBuf,
    relative_path: SkillResourcePath,
    skill_name: &str,
) -> Result<SkillResource, SkillError> {
    let snapshot = read_verified_file_snapshot(&path, MAX_RESOURCE_FILE_BYTES).map_err(
        |failure| match failure {
            FileSnapshotFailure::Unavailable => unavailable(skill_name),
            FileSnapshotFailure::Changed => content_changed(skill_name),
        },
    )?;
    Ok(SkillResource {
        path: relative_path,
        content_digest: snapshot.content_digest,
        bytes: snapshot.bytes,
    })
}

fn invalid_resource_path() -> SkillError {
    SkillError::new(
        SkillErrorKind::InvalidContent,
        "Skill resource path must be a non-empty package-relative path without traversal",
    )
}

fn unavailable(skill_name: &str) -> SkillError {
    SkillError::new(
        SkillErrorKind::SourceUnavailable,
        format!("Skill '{skill_name}' resource is unavailable"),
    )
}

fn content_changed(skill_name: &str) -> SkillError {
    SkillError::new(
        SkillErrorKind::ContentChanged,
        format!("Skill '{skill_name}' content changed after selection"),
    )
}

#[cfg(test)]
#[path = "resource_tests.rs"]
mod tests;
