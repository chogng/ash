use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ash_async_utils::CancellationToken;

use crate::SourceSymbol;
use crate::SourceSymbols;
use crate::SymbolIndexError;
use crate::SymbolIndexSnapshot;
use crate::SymbolSearchHit;

use super::matcher::SymbolDeltaMatcher;
use super::matcher::SymbolMatcher;
use super::matcher::candidate_limit;
use super::matcher::rank_candidates;

pub(super) const MAX_DELTA_FILES: usize = 128;
const MAX_DELTA_SYMBOLS: usize = 16_384;
pub(super) const MAX_DELTA_FACT_BYTES: usize = 4 * 1024 * 1024;

struct SourceCost {
    symbols: usize,
    bytes: usize,
}

/// Immutable input generation. Only the matchers' query scratch is mutable and shared.
pub(super) struct DiskProjection {
    pub snapshot: SymbolIndexSnapshot,
    base: Arc<Mutex<SymbolMatcher>>,
    base_costs: Arc<BTreeMap<PathBuf, SourceCost>>,
    masked_paths: BTreeSet<PathBuf>,
    masked_symbols: usize,
    masked_bytes: usize,
    // Bounded derived facts allow rebuilding the small delta without loading unchanged rows.
    delta_sources: BTreeMap<PathBuf, Arc<SourceSymbols>>,
    delta: Option<Mutex<SymbolDeltaMatcher>>,
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

impl DiskProjection {
    pub fn new(
        snapshot: SymbolIndexSnapshot,
        sources: impl IntoIterator<Item = SourceSymbols>,
        workers: usize,
    ) -> Self {
        let mut base_costs = BTreeMap::new();
        let base = SymbolMatcher::new(
            sources.into_iter().inspect(|source| {
                base_costs.insert(
                    source.source.relative_path.clone(),
                    SourceCost {
                        symbols: source.symbols.len(),
                        bytes: fact_bytes(source),
                    },
                );
            }),
            workers,
        );
        Self {
            snapshot,
            base: Arc::new(Mutex::new(base)),
            base_costs: Arc::new(base_costs),
            masked_paths: BTreeSet::new(),
            masked_symbols: 0,
            masked_bytes: 0,
            delta_sources: BTreeMap::new(),
            delta: None,
        }
    }

    /// Stages an update without changing any published generation or starting worker threads.
    /// None requests compaction; masks and retained facts are bounded even under deletion churn.
    pub fn updated(&self, removed: &[PathBuf], changed: &[SourceSymbols]) -> Option<Self> {
        let mut masked_paths = self.masked_paths.clone();
        let mut masked_symbols = self.masked_symbols;
        let mut masked_bytes = self.masked_bytes;
        for path in removed
            .iter()
            .chain(changed.iter().map(|source| &source.source.relative_path))
        {
            if masked_paths.insert(path.clone()) {
                // A path's first update still refers to its base revision. Later edits must not
                // count the same base symbols again, including new paths absent from the base.
                if let Some(cost) = self.base_costs.get(path) {
                    masked_symbols += cost.symbols;
                    masked_bytes += cost.bytes;
                }
            }
        }
        let budget = self.delta_symbol_budget();
        if masked_paths.len() > MAX_DELTA_FILES
            || masked_symbols > budget
            || masked_bytes > MAX_DELTA_FACT_BYTES
        {
            return None;
        }
        let mut delta_sources = self.delta_sources.clone();
        for path in removed {
            delta_sources.remove(path);
        }
        let mut delta_symbols = delta_sources
            .values()
            .map(|source| source.symbols.len())
            .sum::<usize>();
        let mut delta_bytes = delta_sources
            .values()
            .map(|source| fact_bytes(source))
            .sum::<usize>();
        for source in changed {
            if let Some(previous) = delta_sources.get(&source.source.relative_path) {
                delta_symbols -= previous.symbols.len();
                delta_bytes -= fact_bytes(previous);
            }
            delta_symbols += source.symbols.len();
            delta_bytes += fact_bytes(source);
        }
        // Check the new facts before cloning payloads or allocating a matcher. Count alone does
        // not bound memory when declaration names or containers are unusually long.
        if delta_symbols > budget || delta_bytes > MAX_DELTA_FACT_BYTES {
            return None;
        }
        for source in changed {
            delta_sources.insert(
                source.source.relative_path.clone(),
                Arc::new(source.clone()),
            );
        }
        let delta = delta_sources
            .values()
            .any(|source| !source.symbols.is_empty())
            .then(|| {
                Mutex::new(SymbolDeltaMatcher::new(
                    delta_sources.values().map(|source| source.as_ref().clone()),
                ))
            });
        Some(Self {
            snapshot: self.snapshot.clone(),
            base: Arc::clone(&self.base),
            base_costs: Arc::clone(&self.base_costs),
            masked_paths,
            masked_symbols,
            masked_bytes,
            delta_sources,
            delta,
        })
    }

    pub fn delta_symbol_budget(&self) -> usize {
        (self.snapshot.indexed_symbol_count / 4).clamp(1024, MAX_DELTA_SYMBOLS)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
        dirty_paths: &BTreeSet<PathBuf>,
    ) -> Result<Vec<SymbolSearchHit>, SymbolIndexError> {
        let excluded = self.masked_paths.union(dirty_paths).cloned().collect();
        let mut candidates = self
            .base
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .candidates(query, candidate_limit(limit), cancellation, &excluded)?;
        if let Some(delta) = &self.delta {
            candidates.extend(
                delta
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .candidates(query, candidate_limit(limit), cancellation, dirty_paths)?,
            );
        }
        Ok(rank_candidates(candidates, query, limit))
    }
}

/// Charges the derived facts, including string payloads. Matcher storage is proportional to
/// these facts; this is a retention budget rather than a measurement of allocator overhead.
pub(super) fn fact_bytes(source: &SourceSymbols) -> usize {
    source
        .symbols
        .iter()
        .map(|symbol| {
            std::mem::size_of::<SourceSymbol>()
                + symbol.name.len()
                + symbol.container_name.as_ref().map_or(0, String::len)
        })
        .sum()
}
