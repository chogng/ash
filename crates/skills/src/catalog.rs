mod entry;
mod scanner;
mod snapshot;

pub use entry::{SkillAvailability, SkillCatalogEntry, SkillMetadata};
pub use snapshot::SkillCatalogSnapshot;

use crate::{SkillCatalogGeneration, SkillError, SkillErrorKind, SkillSourceId, SkillSourceRoot};
use scanner::scan_sources;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Owner of controlled source handles and the latest immutable metadata-only projection.
#[derive(Debug)]
pub struct SkillCatalog {
    pub(crate) sources: Vec<SkillSourceRoot>,
    pub(crate) snapshot: Arc<SkillCatalogSnapshot>,
}

impl SkillCatalog {
    /// Performs the initial bounded scan of all supplied roots.
    pub fn discover(mut sources: Vec<SkillSourceRoot>) -> Result<Self, SkillError> {
        sources.sort_by(|left, right| left.view().id().cmp(right.view().id()));
        reject_duplicate_sources(&sources)?;
        let projection = scan_sources(&sources);
        Ok(Self {
            sources,
            snapshot: Arc::new(SkillCatalogSnapshot::new(
                SkillCatalogGeneration::INITIAL,
                projection.entries,
                projection.diagnostics,
            )),
        })
    }

    pub fn snapshot(&self) -> Arc<SkillCatalogSnapshot> {
        Arc::clone(&self.snapshot)
    }

    /// Rescans controlled roots and publishes a new generation only when visible metadata,
    /// content digests, availability, or diagnostics changed.
    pub fn refresh(&mut self) -> Arc<SkillCatalogSnapshot> {
        let projection = scan_sources(&self.sources);
        if self
            .snapshot
            .same_projection(&projection.entries, &projection.diagnostics)
        {
            return Arc::clone(&self.snapshot);
        }
        self.snapshot = Arc::new(SkillCatalogSnapshot::new(
            self.snapshot.generation().next(),
            projection.entries,
            projection.diagnostics,
        ));
        Arc::clone(&self.snapshot)
    }
}

fn reject_duplicate_sources(sources: &[SkillSourceRoot]) -> Result<(), SkillError> {
    let mut ids = BTreeSet::<&SkillSourceId>::new();
    for source in sources {
        if !ids.insert(source.view().id()) {
            return Err(SkillError::new(
                SkillErrorKind::DuplicateSource,
                format!(
                    "skill source '{}' was registered more than once",
                    source.view().id()
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
