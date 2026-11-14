use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use crate::Codebase;
use crate::CodebaseManifest;
use crate::IndexRootId;
use crate::SymbolProjectionUpdate;
use crate::symbol::projection::DiskProjection;
use crate::symbol::projection::MAX_DELTA_FACT_BYTES;
use crate::symbol::projection::MAX_DELTA_FILES;
use crate::symbol::projection::fact_bytes;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;

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
    projection: RwLock<Arc<DiskProjection>>,
    overlay: RwLock<OverlayProjection>,
}

struct OverlayProjection {
    generation: u64,
    dirty_paths: BTreeSet<PathBuf>,
    matcher: Option<Arc<Mutex<SymbolMatcher>>>,
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
        let projection = DiskProjection::new(
            projection.snapshot,
            projection.sources.into_values(),
            limits.matcher_threads,
        );
        Ok(Self {
            codebase,
            limits,
            store,
            operation: Mutex::new(()),
            projection: RwLock::new(Arc::new(projection)),
            overlay: RwLock::new(OverlayProjection {
                generation: 0,
                dirty_paths: BTreeSet::new(),
                matcher: None,
            }),
        })
    }

    /// Returns the stable identity of the canonical Codebase root projected by this index.
    pub fn root_id(&self) -> &IndexRootId {
        self.codebase.root_id()
    }

    /// Returns the currently published symbol projection without reading source files.
    pub fn snapshot(&self) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        Ok(self
            .projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot
            .clone())
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
        let source_snapshot = self.codebase.snapshot()?;
        let symbol_snapshot = self.store.snapshot(self.codebase.root_id())?;
        let published = Arc::clone(
            &self
                .projection
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        if symbol_snapshot.source_generation == source_snapshot.generation {
            if symbol_snapshot.generation == published.snapshot.generation {
                return Ok(SymbolIndexRefreshOutcome::NoChange);
            }
            // Another publisher can advance shared storage. Rebase before applying any deltas.
            let stored = self.store.load_projection(self.codebase.root_id())?;
            let snapshot = stored.snapshot.clone();
            let projection = DiskProjection::new(
                stored.snapshot,
                stored.sources.into_values(),
                self.limits.matcher_threads,
            );
            *self
                .projection
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(projection);
            return Ok(SymbolIndexRefreshOutcome::Published(snapshot));
        }
        let manifest = self.codebase.manifest()?;
        if manifest.snapshot.root_id != *self.codebase.root_id() {
            return Err(SymbolIndexError::SourceRootMismatch);
        }
        'incremental: {
            if symbol_snapshot.generation == 0
                || symbol_snapshot.symbol_limit_hit
                || symbol_snapshot.generation != published.snapshot.generation
            {
                break 'incremental;
            }
            let stored = self.store.load_manifest(self.codebase.root_id())?;
            if stored.snapshot.generation != symbol_snapshot.generation {
                return Err(SymbolIndexError::storage(
                    "symbol projection changed while preparing an update",
                ));
            }
            let current_paths: BTreeSet<_> = manifest
                .sources
                .iter()
                .map(|source| source.relative_path.clone())
                .collect();
            let removed: Vec<_> = stored
                .sources
                .keys()
                .filter(|path| !current_paths.contains(*path))
                .cloned()
                .collect();
            let mut changed = Vec::new();
            let mut changed_symbols = 0;
            let mut changed_bytes = 0;
            let mut symbol_count = stored.snapshot.indexed_symbol_count;
            for path in &removed {
                symbol_count = symbol_count.saturating_sub(stored.sources[path].symbol_count);
            }
            for source in &manifest.sources {
                let previous = stored.sources.get(&source.relative_path);
                if previous.is_some_and(|previous| previous.source == *source) {
                    continue;
                }
                if changed.len() + removed.len() >= MAX_DELTA_FILES {
                    break 'incremental;
                }
                let materialized = self.codebase.materialize_source(source)?;
                let extracted = extract_source(&materialized, self.limits.max_symbols_per_source)?;
                symbol_count = symbol_count
                    .saturating_sub(previous.map_or(0, |source| source.symbol_count))
                    .saturating_add(extracted.symbols.len());
                if symbol_count > self.limits.max_total_symbols {
                    break 'incremental;
                }
                let extracted = SourceSymbols {
                    source: source.clone(),
                    symbols: extracted.symbols,
                    symbol_limit_hit: extracted.symbol_limit_hit,
                };
                changed_symbols += extracted.symbols.len();
                changed_bytes += fact_bytes(&extracted);
                // Stop staging a bulk edit as soon as it requires compaction; do not retain
                // an entire changed workspace only to discard it before the full pass.
                if changed_symbols > published.delta_symbol_budget()
                    || changed_bytes > MAX_DELTA_FACT_BYTES
                {
                    break 'incremental;
                }
                changed.push(extracted);
            }
            let Some(mut projection) = published.updated(&removed, &changed) else {
                break 'incremental;
            };
            let snapshot = self.store.update_projection(
                self.codebase.root_id(),
                SymbolProjectionUpdate {
                    expected_generation: stored.snapshot.generation,
                    source_generation: manifest.snapshot.generation,
                    removed: &removed,
                    changed: &changed,
                    symbol_limit_hit: changed.iter().any(|source| source.symbol_limit_hit),
                },
            )?;
            projection.snapshot = snapshot.clone();
            *self
                .projection
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(projection);
            return Ok(SymbolIndexRefreshOutcome::Published(snapshot));
        }
        self.reconcile_full(manifest)
    }

    // Limit changes can move the truncation boundary into unchanged files. Rebuild that
    // exceptional case in manifest order so coverage and limit flags retain their meaning.
    fn reconcile_full(
        &self,
        manifest: CodebaseManifest,
    ) -> Result<SymbolIndexRefreshOutcome, SymbolIndexError> {
        let mut stored = self.store.load_projection(self.codebase.root_id())?;
        if stored.snapshot.source_generation == manifest.snapshot.generation {
            let snapshot = stored.snapshot.clone();
            let projection = DiskProjection::new(
                stored.snapshot,
                stored.sources.into_values(),
                self.limits.matcher_threads,
            );
            *self
                .projection
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(projection);
            return Ok(SymbolIndexRefreshOutcome::Published(snapshot));
        }

        let reuse_allowed = !stored.snapshot.symbol_limit_hit;
        let mut sources = Vec::with_capacity(manifest.sources.len());
        let mut remaining = self.limits.max_total_symbols;
        let mut total_limit_hit = false;
        for source in &manifest.sources {
            // Retire changed cached facts before parsing their replacement. Source text is
            // verified and extracted one file at a time; publication remains all-or-nothing.
            let previous = stored
                .sources
                .remove(&source.relative_path)
                .filter(|previous| {
                    reuse_allowed
                        && previous.source.source_revision == source.source_revision
                        && previous.source.language == source.language
                });
            let mut source_symbols = if let Some(previous) = previous {
                SourceSymbols {
                    source: source.clone(),
                    symbols: previous.symbols,
                    symbol_limit_hit: previous.symbol_limit_hit,
                }
            } else {
                let materialized = self.codebase.materialize_source(source)?;
                let extracted = extract_source(&materialized, self.limits.max_symbols_per_source)?;
                SourceSymbols {
                    source: source.clone(),
                    symbols: extracted.symbols,
                    symbol_limit_hit: extracted.symbol_limit_hit,
                }
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
        // File metadata is shared inside the matcher. Build it before publication
        // so the first query does not pay for loading the entire stored projection.
        drop(stored);
        let projection =
            DiskProjection::new(snapshot.clone(), sources, self.limits.matcher_threads);
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(projection);
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
            (overlay.dirty_paths.clone(), overlay.matcher.clone())
        };
        let projection = Arc::clone(
            &self
                .projection
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let mut hits = projection.search(
            query.text(),
            self.limits.max_results,
            cancellation,
            &dirty_paths,
        )?;
        if let Some(overlay_matcher) = overlay_matcher {
            hits.extend(
                overlay_matcher
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .search(query.text(), result_limit, cancellation)?,
            );
        }
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
        let mut sources = Vec::new();
        let mut symbol_count = 0usize;
        for document in snapshot.documents {
            let remaining = self.limits.max_total_symbols.saturating_sub(symbol_count);
            if remaining == 0 {
                break;
            }
            let extracted = extract_source(
                &document.source,
                self.limits.max_symbols_per_source.min(remaining),
            )?;
            symbol_count += extracted.symbols.len();
            sources.push(SourceSymbols {
                source: document.source.reference,
                symbols: extracted.symbols,
                symbol_limit_hit: extracted.symbol_limit_hit,
            });
        }
        // Dirty paths still mask disk symbols when their text has no declarations.
        // Only a populated overlay needs a matcher and its private worker pool.
        let matcher = sources
            .iter()
            .any(|source| !source.symbols.is_empty())
            .then(|| {
                Arc::new(Mutex::new(SymbolMatcher::new(
                    sources,
                    self.limits.matcher_threads,
                )))
            });
        *self
            .overlay
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = OverlayProjection {
            generation,
            dirty_paths,
            matcher,
        };
        Ok(())
    }
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
