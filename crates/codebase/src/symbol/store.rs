use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::{
    IndexRootId, IndexedSourceReference, SymbolIndexError, SymbolIndexSnapshot, SymbolKind,
    SymbolRange,
};

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

/// Persistence port used by the Codebase symbol projection.
pub trait SymbolIndexStore: Send + Sync {
    fn snapshot(&self, root_id: &IndexRootId) -> Result<SymbolIndexSnapshot, SymbolIndexError>;
    fn load_projection(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolProjection, SymbolIndexError>;
    fn replace_projection(
        &self,
        root_id: &IndexRootId,
        source_generation: u64,
        sources: &[SourceSymbols],
        symbol_limit_hit: bool,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError>;
}
