use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use crate::Codebase;
use crate::IndexRootId;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;

use crate::IndexedSymbol;
use crate::SymbolIndexError;
use crate::SymbolIndexLimits;
use crate::SymbolIndexQuery;
use crate::SymbolIndexRefreshOutcome;
use crate::SymbolIndexSnapshot;
use crate::SymbolSearchHit;
use crate::symbol::extractor::extract_source;
use crate::symbol::matcher::SymbolMatcher;
use crate::symbol::matcher::sort_hits;
use crate::symbol::memory_store::InMemorySymbolIndexStore;
use crate::symbol::store::SourceSymbols;
use crate::symbol::store::SymbolIndexStore;

/// Directory-side symbol projection backed by one canonical [`Codebase`] source authority.
pub struct SymbolIndex {
    codebase: Arc<Codebase>,
    limits: SymbolIndexLimits,
    store: Arc<dyn SymbolIndexStore>,
    operation: Mutex<()>,
    matcher: RwLock<Arc<Mutex<SymbolMatcher>>>,
    overlay: RwLock<OverlayProjection>,
}

struct OverlayProjection {
    generation: u64,
    dirty_paths: BTreeSet<PathBuf>,
    matcher: Arc<Mutex<SymbolMatcher>>,
}

impl SymbolIndex {
    /// Opens a process-local symbol projection.
    pub fn open_memory(
        codebase: Arc<Codebase>,
        limits: SymbolIndexLimits,
    ) -> Result<Self, SymbolIndexError> {
        let store = Arc::new(InMemorySymbolIndexStore::new(codebase.root_id().clone()));
        Self::open(codebase, store, limits)
    }

    /// Opens a rebuildable symbol projection for the exact root owned by `codebase`.
    pub fn open(
        codebase: Arc<Codebase>,
        store: Arc<dyn SymbolIndexStore>,
        limits: SymbolIndexLimits,
    ) -> Result<Self, SymbolIndexError> {
        validate_limits(&limits)?;
        let projection = store.load_projection(codebase.root_id())?;
        let matcher = SymbolMatcher::new(
            flatten_symbols(projection.sources.values()),
            limits.matcher_threads,
        );
        let empty_overlay_matcher = SymbolMatcher::new(Vec::new(), limits.matcher_threads);
        Ok(Self {
            codebase,
            limits,
            store,
            operation: Mutex::new(()),
            matcher: RwLock::new(Arc::new(Mutex::new(matcher))),
            overlay: RwLock::new(OverlayProjection {
                generation: 0,
                dirty_paths: BTreeSet::new(),
                matcher: Arc::new(Mutex::new(empty_overlay_matcher)),
            }),
        })
    }

    /// Returns the stable identity of the canonical Codebase root projected by this index.
    pub fn root_id(&self) -> &IndexRootId {
        self.codebase.root_id()
    }

    /// Returns the currently published symbol projection without reading source files.
    pub fn snapshot(&self) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        self.store.snapshot(self.codebase.root_id())
    }

    /// Reconciles this projection against the current Codebase manifest.
    ///
    /// Unchanged source revisions reuse persisted symbols; changed sources are materialized through
    /// Codebase so this crate never creates a second filesystem scanner or source authority.
    pub fn reconcile(&self) -> Result<SymbolIndexRefreshOutcome, SymbolIndexError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let manifest = self.codebase.manifest()?;
        if manifest.snapshot.root_id != *self.codebase.root_id() {
            return Err(SymbolIndexError::SourceRootMismatch);
        }
        let stored = self.store.load_projection(self.codebase.root_id())?;
        if stored.snapshot.source_generation == manifest.snapshot.generation {
            return Ok(SymbolIndexRefreshOutcome::NoChange);
        }

        let reuse_allowed = !stored.snapshot.symbol_limit_hit;
        let mut materialize = Vec::new();
        for source in &manifest.sources {
            let reusable = reuse_allowed
                && stored
                    .sources
                    .get(&source.relative_path)
                    .is_some_and(|previous| {
                        previous.source.source_revision == source.source_revision
                            && previous.source.language == source.language
                    });
            if !reusable {
                materialize.push(source.clone());
            }
        }
        let materialized = self
            .codebase
            .materialize_sources(&materialize)?
            .into_iter()
            .map(|source| (source.reference.relative_path.clone(), source))
            .collect::<BTreeMap<_, _>>();

        let mut sources = Vec::with_capacity(manifest.sources.len());
        let mut remaining = self.limits.max_total_symbols;
        let mut total_limit_hit = false;
        for source in &manifest.sources {
            let mut source_symbols = if let Some(materialized) =
                materialized.get(&source.relative_path)
            {
                let extracted = extract_source(materialized, self.limits.max_symbols_per_source)?;
                SourceSymbols {
                    source: source.clone(),
                    symbols: extracted.symbols,
                    symbol_limit_hit: extracted.symbol_limit_hit,
                }
            } else {
                stored
                    .sources
                    .get(&source.relative_path)
                    .map(|previous| SourceSymbols {
                        source: source.clone(),
                        symbols: previous.symbols.clone(),
                        symbol_limit_hit: previous.symbol_limit_hit,
                    })
                    .ok_or(SymbolIndexError::SourceRootMismatch)?
            };
            if source_symbols.symbols.len() > remaining {
                source_symbols.symbols.truncate(remaining);
                source_symbols.symbol_limit_hit = true;
                total_limit_hit = true;
            }
            remaining = remaining.saturating_sub(source_symbols.symbols.len());
            total_limit_hit |= source_symbols.symbol_limit_hit;
            sources.push(source_symbols);
        }
        let snapshot = self.store.replace_projection(
            self.codebase.root_id(),
            manifest.snapshot.generation,
            &sources,
            total_limit_hit,
        )?;
        let matcher =
            SymbolMatcher::new(flatten_symbols(sources.iter()), self.limits.matcher_threads);
        *self
            .matcher
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(Mutex::new(matcher));
        Ok(SymbolIndexRefreshOutcome::Published(snapshot))
    }

    /// Searches the latest published immutable symbol snapshot.
    pub fn search(
        &self,
        query: &SymbolIndexQuery,
    ) -> Result<Vec<SymbolSearchHit>, SymbolIndexError> {
        let cancellation = CancellationSource::new();
        self.search_with_cancellation(query, &cancellation.token())
    }

    /// Searches while observing cooperative cancellation between matcher ticks.
    pub fn search_with_cancellation(
        &self,
        query: &SymbolIndexQuery,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SymbolSearchHit>, SymbolIndexError> {
        if query.text().len() > self.limits.max_query_bytes {
            return Err(SymbolIndexError::QueryTooLarge);
        }
        self.reconcile_overlay()?;
        let result_limit = query.result_limit().get().min(self.limits.max_results);
        let (dirty_paths, overlay_matcher) = {
            let overlay = self
                .overlay
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (overlay.dirty_paths.clone(), Arc::clone(&overlay.matcher))
        };
        let matcher = self
            .matcher
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut hits = matcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .search(query.text(), self.limits.max_results, cancellation)?
            .into_iter()
            .filter(|hit| !dirty_paths.contains(&hit.symbol.reference.relative_path))
            .collect::<Vec<_>>();
        hits.extend(
            overlay_matcher
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .search(query.text(), result_limit, cancellation)?,
        );
        sort_hits(&mut hits);
        hits.truncate(result_limit);
        Ok(hits)
    }

    /// Rebuilds the ephemeral symbol candidate set from the canonical Codebase overlay.
    pub fn reconcile_overlay(&self) -> Result<(), SymbolIndexError> {
        let snapshot = self.codebase.overlay_snapshot();
        if self
            .overlay
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
            == snapshot.generation
        {
            return Ok(());
        }
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = self.codebase.overlay_snapshot();
        if self
            .overlay
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
            == snapshot.generation
        {
            return Ok(());
        }
        let generation = snapshot.generation;
        let dirty_paths = snapshot
            .documents
            .iter()
            .map(|document| document.source.reference.relative_path.clone())
            .collect();
        let mut symbols = Vec::new();
        for document in snapshot.documents {
            let remaining = self.limits.max_total_symbols.saturating_sub(symbols.len());
            if remaining == 0 {
                break;
            }
            let extracted = extract_source(
                &document.source,
                self.limits.max_symbols_per_source.min(remaining),
            )?;
            symbols.extend(extracted.symbols);
        }
        let matcher = SymbolMatcher::new(symbols, self.limits.matcher_threads);
        *self
            .overlay
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = OverlayProjection {
            generation,
            dirty_paths,
            matcher: Arc::new(Mutex::new(matcher)),
        };
        Ok(())
    }
}

fn flatten_symbols<'a>(sources: impl IntoIterator<Item = &'a SourceSymbols>) -> Vec<IndexedSymbol> {
    sources
        .into_iter()
        .flat_map(|source| source.symbols.iter().cloned())
        .collect()
}

fn validate_limits(limits: &SymbolIndexLimits) -> Result<(), SymbolIndexError> {
    if limits.max_symbols_per_source == 0 {
        return Err(SymbolIndexError::InvalidLimits(
            "max_symbols_per_source must be non-zero",
        ));
    }
    if limits.max_total_symbols == 0 {
        return Err(SymbolIndexError::InvalidLimits(
            "max_total_symbols must be non-zero",
        ));
    }
    if limits.max_results == 0 || limits.max_query_bytes == 0 || limits.matcher_threads == 0 {
        return Err(SymbolIndexError::InvalidLimits(
            "query and matcher limits must be non-zero",
        ));
    }
    Ok(())
}
