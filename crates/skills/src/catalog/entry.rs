use crate::{ContentDigest, SkillCompatibility, SkillId, SkillSourceView};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillAvailability {
    Available,
}

/// Validated discovery metadata retained without the Markdown instruction body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillMetadata {
    description: String,
    license: Option<String>,
    metadata: BTreeMap<String, String>,
    allowed_tools_hint: Option<String>,
}

impl SkillMetadata {
    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn license(&self) -> Option<&str> {
        self.license.as_deref()
    }

    pub fn extensions(&self) -> &BTreeMap<String, String> {
        &self.metadata
    }

    /// Returns author-declared tool intent, never an execution approval.
    pub fn allowed_tools_hint(&self) -> Option<&str> {
        self.allowed_tools_hint.as_deref()
    }

    pub(crate) fn new(
        description: String,
        license: Option<String>,
        metadata: BTreeMap<String, String>,
        allowed_tools_hint: Option<String>,
    ) -> Self {
        Self {
            description,
            license,
            metadata,
            allowed_tools_hint,
        }
    }
}

/// One valid metadata-only Skill catalog entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillCatalogEntry {
    id: SkillId,
    source: SkillSourceView,
    content_digest: ContentDigest,
    metadata: SkillMetadata,
    compatibility: SkillCompatibility,
    availability: SkillAvailability,
}

impl SkillCatalogEntry {
    pub fn id(&self) -> &SkillId {
        &self.id
    }

    pub fn source(&self) -> &SkillSourceView {
        &self.source
    }

    pub fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }

    pub fn metadata(&self) -> &SkillMetadata {
        &self.metadata
    }

    pub fn compatibility(&self) -> &SkillCompatibility {
        &self.compatibility
    }

    pub fn availability(&self) -> SkillAvailability {
        self.availability
    }

    pub(crate) fn new(
        id: SkillId,
        source: SkillSourceView,
        content_digest: ContentDigest,
        metadata: SkillMetadata,
        compatibility: SkillCompatibility,
    ) -> Self {
        Self {
            id,
            source,
            content_digest,
            metadata,
            compatibility,
            availability: SkillAvailability::Available,
        }
    }
}
