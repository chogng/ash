use crate::{SkillCatalogEntry, SkillCatalogGeneration, SkillDiagnostic, SkillId};

/// Immutable, deterministically ordered metadata-only catalog projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillCatalogSnapshot {
    generation: SkillCatalogGeneration,
    entries: Vec<SkillCatalogEntry>,
    diagnostics: Vec<SkillDiagnostic>,
}

impl SkillCatalogSnapshot {
    pub(crate) fn new(
        generation: SkillCatalogGeneration,
        entries: Vec<SkillCatalogEntry>,
        diagnostics: Vec<SkillDiagnostic>,
    ) -> Self {
        Self {
            generation,
            entries,
            diagnostics,
        }
    }

    pub fn generation(&self) -> SkillCatalogGeneration {
        self.generation
    }

    pub fn list(&self) -> &[SkillCatalogEntry] {
        &self.entries
    }

    pub fn read(&self, id: &SkillId) -> Option<&SkillCatalogEntry> {
        self.entries
            .binary_search_by(|entry| entry.id().cmp(id))
            .ok()
            .map(|index| &self.entries[index])
    }

    pub fn diagnostics(&self) -> &[SkillDiagnostic] {
        &self.diagnostics
    }

    pub(crate) fn same_projection(
        &self,
        entries: &[SkillCatalogEntry],
        diagnostics: &[SkillDiagnostic],
    ) -> bool {
        self.entries == entries && self.diagnostics == diagnostics
    }
}
