use std::collections::BTreeMap;
use std::sync::RwLock;

use crate::IndexRootId;
use crate::SourceSymbols;
use crate::StoredSymbolManifest;
use crate::StoredSymbolProjection;
use crate::SymbolIndexError;
use crate::SymbolIndexSnapshot;
use crate::SymbolIndexStore;
use crate::SymbolProjectionUpdate;
use crate::SymbolSourceSummary;

pub(crate) struct InMemorySymbolIndexStore {
    state: RwLock<State>,
}

struct State {
    snapshot: SymbolIndexSnapshot,
    sources: BTreeMap<std::path::PathBuf, SourceSymbols>,
}

impl InMemorySymbolIndexStore {
    pub fn new(root_id: IndexRootId) -> Self {
        Self {
            state: RwLock::new(State {
                snapshot: SymbolIndexSnapshot {
                    root_id,
                    generation: 0,
                    source_generation: 0,
                    indexed_source_count: 0,
                    indexed_symbol_count: 0,
                    symbol_limit_hit: false,
                },
                sources: BTreeMap::new(),
            }),
        }
    }
}

impl SymbolIndexStore for InMemorySymbolIndexStore {
    fn snapshot(&self, root_id: &IndexRootId) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        ensure_root(root_id, &state.snapshot.root_id)?;
        Ok(state.snapshot.clone())
    }

    fn load_projection(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolProjection, SymbolIndexError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        ensure_root(root_id, &state.snapshot.root_id)?;
        Ok(StoredSymbolProjection {
            snapshot: state.snapshot.clone(),
            sources: state.sources.clone(),
        })
    }

    fn load_manifest(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolManifest, SymbolIndexError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        ensure_root(root_id, &state.snapshot.root_id)?;
        Ok(StoredSymbolManifest {
            snapshot: state.snapshot.clone(),
            sources: state
                .sources
                .iter()
                .map(|(path, source)| {
                    (
                        path.clone(),
                        SymbolSourceSummary {
                            source: source.source.clone(),
                            symbol_count: source.symbols.len(),
                        },
                    )
                })
                .collect(),
        })
    }

    fn update_projection(
        &self,
        root_id: &IndexRootId,
        update: SymbolProjectionUpdate<'_>,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        ensure_root(root_id, &state.snapshot.root_id)?;
        if state.snapshot.generation != update.expected_generation {
            return Err(SymbolIndexError::storage(
                "symbol projection changed while preparing an update",
            ));
        }
        for path in update.removed {
            state.sources.remove(path);
        }
        for source in update.changed {
            state
                .sources
                .insert(source.source.relative_path.clone(), source.clone());
        }
        state.snapshot = SymbolIndexSnapshot {
            root_id: root_id.clone(),
            generation: update.expected_generation.saturating_add(1),
            source_generation: update.source_generation,
            indexed_source_count: state.sources.len(),
            indexed_symbol_count: state
                .sources
                .values()
                .map(|source| source.symbols.len())
                .sum(),
            symbol_limit_hit: update.symbol_limit_hit,
        };
        Ok(state.snapshot.clone())
    }

    fn replace_projection(
        &self,
        root_id: &IndexRootId,
        source_generation: u64,
        sources: &[SourceSymbols],
        symbol_limit_hit: bool,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        ensure_root(root_id, &state.snapshot.root_id)?;
        state.sources = sources
            .iter()
            .cloned()
            .map(|source| (source.source.relative_path.clone(), source))
            .collect();
        state.snapshot = SymbolIndexSnapshot {
            root_id: root_id.clone(),
            generation: state.snapshot.generation.saturating_add(1),
            source_generation,
            indexed_source_count: state.sources.len(),
            indexed_symbol_count: state
                .sources
                .values()
                .map(|source| source.symbols.len())
                .sum(),
            symbol_limit_hit,
        };
        Ok(state.snapshot.clone())
    }
}

fn ensure_root(expected: &IndexRootId, actual: &IndexRootId) -> Result<(), SymbolIndexError> {
    if expected == actual {
        Ok(())
    } else {
        Err(SymbolIndexError::StorageRootMismatch)
    }
}
