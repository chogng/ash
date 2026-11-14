use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::IndexRootId;
use crate::IndexedSourceReference;
use crate::SymbolIndexError;
use crate::SymbolIndexSnapshot;
use crate::SymbolKind;
use crate::SymbolRange;

/// Declaration facts relative to the single source identity in [`SourceSymbols`].
/// Full revision-bound references are materialized only for returned search hits.
#[derive(Clone)]
pub struct SourceSymbol {
    pub ordinal: usize,
    pub name: String,
    pub kind: SymbolKind,
    pub container_name: Option<String>,
    pub declaration_range: SymbolRange,
    pub selection_range: SymbolRange,
}

/// Symbols extracted from one exact source revision.
#[derive(Clone)]
pub struct SourceSymbols {
    pub source: IndexedSourceReference,
    pub symbols: Vec<SourceSymbol>,
    pub symbol_limit_hit: bool,
}

/// Complete stored symbol generation used for incremental reconciliation.
pub struct StoredSymbolProjection {
    pub snapshot: SymbolIndexSnapshot,
    pub sources: BTreeMap<PathBuf, SourceSymbols>,
}

/// File identities and counts used to plan an update without loading declaration payloads.
pub struct StoredSymbolManifest {
    pub snapshot: SymbolIndexSnapshot,
    pub sources: BTreeMap<PathBuf, SymbolSourceSummary>,
}

/// Persisted coverage of one verified file revision.
pub struct SymbolSourceSummary {
    pub source: IndexedSourceReference,
    pub symbol_count: usize,
}

/// Borrowed file changes for one compare-and-swap publication; unchanged payloads stay in storage.
pub struct SymbolProjectionUpdate<'a> {
    pub expected_generation: u64,
    pub source_generation: u64,
    pub removed: &'a [PathBuf],
    pub changed: &'a [SourceSymbols],
    pub symbol_limit_hit: bool,
}

/// Persistence port used by the Codebase symbol projection.
pub trait SymbolIndexStore: Send + Sync {
    fn snapshot(&self, root_id: &IndexRootId) -> Result<SymbolIndexSnapshot, SymbolIndexError>;
    fn load_projection(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolProjection, SymbolIndexError>;
    fn load_manifest(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolManifest, SymbolIndexError>;
    /// Atomically updates changed files and metadata if the planned generation is still current.
    fn update_projection(
        &self,
        root_id: &IndexRootId,
        update: SymbolProjectionUpdate<'_>,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError>;
    fn replace_projection(
        &self,
        root_id: &IndexRootId,
        source_generation: u64,
        sources: &[SourceSymbols],
        symbol_limit_hit: bool,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError>;
}
