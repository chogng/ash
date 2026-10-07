use crate::SkillError;
use crate::SkillErrorKind;
use crate::SkillName;
use crate::SkillSourceId;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SkillSourceKind {
    BuiltIn,
    User,
    Directory,
    Plugin,
    Marketplace,
}

/// Consumer-visible Skill source provenance without its private host root.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SkillSourceView {
    id: SkillSourceId,
    kind: SkillSourceKind,
}

impl SkillSourceView {
    pub fn id(&self) -> &SkillSourceId {
        &self.id
    }

    pub fn kind(&self) -> SkillSourceKind {
        self.kind
    }

    pub fn allows_automatic_activation(&self) -> bool {
        self.kind == SkillSourceKind::BuiltIn
    }
}

/// Validated, read-only root supplied by the host to catalog discovery.
///
/// Hosts must construct a new handle when configuration changes. The handle validates that the
/// initial root is a real directory and stores its canonical path privately; each scan rechecks
/// containment and file types because local files can still change after construction.
#[derive(Clone)]
pub struct SkillSourceRoot {
    view: SkillSourceView,
    canonical_root: PathBuf,
    layout: SkillSourceLayout,
}

#[derive(Clone)]
enum SkillSourceLayout {
    Collection,
    ExactSkill(SkillName),
}

impl SkillSourceRoot {
    pub fn built_in(id: SkillSourceId, root: impl AsRef<Path>) -> Result<Self, SkillError> {
        Self::new(id, SkillSourceKind::BuiltIn, root.as_ref())
    }

    pub fn user(id: SkillSourceId, root: impl AsRef<Path>) -> Result<Self, SkillError> {
        Self::new(id, SkillSourceKind::User, root.as_ref())
    }

    pub fn directory(id: SkillSourceId, root: impl AsRef<Path>) -> Result<Self, SkillError> {
        Self::new(id, SkillSourceKind::Directory, root.as_ref())
    }

    /// Creates a source for one exact manifest-declared Skill directory in a verified Plugin.
    pub fn plugin(
        id: SkillSourceId,
        name: SkillName,
        root: impl AsRef<Path>,
    ) -> Result<Self, SkillError> {
        Self::new_exact(id, SkillSourceKind::Plugin, name, root.as_ref())
    }

    /// Creates a source for one exact Skill capability in a Marketplace-verified package.
    pub fn marketplace(
        id: SkillSourceId,
        name: SkillName,
        root: impl AsRef<Path>,
    ) -> Result<Self, SkillError> {
        Self::new_exact(id, SkillSourceKind::Marketplace, name, root.as_ref())
    }

    pub fn view(&self) -> &SkillSourceView {
        &self.view
    }

    /// Returns the private host root for runtime composition and file watching.
    ///
    /// Consumer-facing projections must use [`Self::view`] and must not serialize this path.
    pub fn host_root(&self) -> &Path {
        &self.canonical_root
    }

    pub(crate) fn skill_directory(&self, name: &SkillName) -> Option<PathBuf> {
        match &self.layout {
            SkillSourceLayout::Collection => Some(self.canonical_root.join(name.as_str())),
            SkillSourceLayout::ExactSkill(exact) if exact == name => {
                Some(self.canonical_root.clone())
            }
            SkillSourceLayout::ExactSkill(_) => None,
        }
    }

    pub(crate) fn exact_skill_name(&self) -> Option<&SkillName> {
        match &self.layout {
            SkillSourceLayout::Collection => None,
            SkillSourceLayout::ExactSkill(name) => Some(name),
        }
    }

    fn new(id: SkillSourceId, kind: SkillSourceKind, root: &Path) -> Result<Self, SkillError> {
        let metadata = fs::symlink_metadata(root).map_err(|_| source_unavailable(&id))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(source_unavailable(&id));
        }
        let canonical_root = root.canonicalize().map_err(|_| source_unavailable(&id))?;
        Ok(Self {
            view: SkillSourceView { id, kind },
            canonical_root,
            layout: SkillSourceLayout::Collection,
        })
    }

    fn new_exact(
        id: SkillSourceId,
        kind: SkillSourceKind,
        name: SkillName,
        root: &Path,
    ) -> Result<Self, SkillError> {
        let mut source = Self::new(id, kind, root)?;
        source.layout = SkillSourceLayout::ExactSkill(name);
        Ok(source)
    }
}

impl fmt::Debug for SkillSourceRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SkillSourceRoot")
            .field("view", &self.view)
            .field("canonical_root", &"<private>")
            .finish()
    }
}

fn source_unavailable(id: &SkillSourceId) -> SkillError {
    SkillError::new(
        SkillErrorKind::SourceUnavailable,
        format!("skill source '{id}' does not exist or is not a real readable directory"),
    )
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;
