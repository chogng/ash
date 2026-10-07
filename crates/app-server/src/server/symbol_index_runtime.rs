use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use ash_codebase::Codebase;
use ash_codebase::SymbolIndex;
use ash_codebase::SymbolIndexError;
use ash_codebase::SymbolIndexLimits;
use ash_codebase::SymbolIndexQuery;
use ash_codebase::SymbolIndexRefreshOutcome;
use ash_codebase::SymbolIndexSnapshot;
use ash_codebase::SymbolSearchHit;
use ash_codebase_store::CodebaseStore;

/// App Server-owned lifecycle projection for one directory symbol index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum SymbolIndexRuntimeState {
    Empty,
    Indexing {
        last_ready: Option<SymbolIndexSnapshot>,
    },
    Ready(SymbolIndexSnapshot),
    Stale(SymbolIndexSnapshot),
    Failed,
}

pub(super) struct SymbolIndexRuntime {
    source_index: Arc<Codebase>,
    index: Arc<SymbolIndex>,
    operation: Mutex<()>,
    state: RwLock<SymbolIndexRuntimeState>,
}

impl SymbolIndexRuntime {
    pub fn open(
        source_index: Arc<Codebase>,
        store: Arc<CodebaseStore>,
    ) -> Result<Arc<Self>, SymbolIndexError> {
        let index =
            store.open_symbol_index(Arc::clone(&source_index), SymbolIndexLimits::default())?;
        let index = Arc::new(index);
        let snapshot = index.snapshot()?;
        let state = if snapshot.generation == 0 {
            SymbolIndexRuntimeState::Empty
        } else {
            SymbolIndexRuntimeState::Stale(snapshot)
        };
        Ok(Arc::new(Self {
            source_index,
            index,
            operation: Mutex::new(()),
            state: RwLock::new(state),
        }))
    }

    pub fn state(&self) -> SymbolIndexRuntimeState {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn root_id(&self) -> &ash_codebase::IndexRootId {
        self.source_index.root_id()
    }

    pub fn index(&self) -> Arc<SymbolIndex> {
        Arc::clone(&self.index)
    }

    pub fn reconcile(&self) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let last_ready = ready_snapshot(&self.state());
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = SymbolIndexRuntimeState::Indexing {
            last_ready: last_ready.clone(),
        };
        let result = self.index.reconcile().and_then(|outcome| match outcome {
            SymbolIndexRefreshOutcome::NoChange => self.index.snapshot(),
            SymbolIndexRefreshOutcome::Published(snapshot) => Ok(snapshot),
        });
        match result {
            Ok(snapshot) => {
                self.publish_ready(snapshot.clone());
                Ok(snapshot)
            }
            Err(error) => {
                let fallback = last_ready.map_or(
                    SymbolIndexRuntimeState::Failed,
                    SymbolIndexRuntimeState::Stale,
                );
                *self
                    .state
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = fallback;
                Err(error)
            }
        }
    }

    pub fn search(
        &self,
        query: &SymbolIndexQuery,
    ) -> Result<Vec<SymbolSearchHit>, SymbolIndexRuntimeError> {
        self.observe_source_generation()?;
        match self.state() {
            SymbolIndexRuntimeState::Ready(_) | SymbolIndexRuntimeState::Stale(_) => self
                .index
                .search(query)
                .map_err(SymbolIndexRuntimeError::Index),
            SymbolIndexRuntimeState::Indexing {
                last_ready: Some(_),
            } => self
                .index
                .search(query)
                .map_err(SymbolIndexRuntimeError::Index),
            SymbolIndexRuntimeState::Empty
            | SymbolIndexRuntimeState::Indexing { last_ready: None }
            | SymbolIndexRuntimeState::Failed => Err(SymbolIndexRuntimeError::NotReady),
        }
    }

    pub fn reconcile_overlay(&self) -> Result<(), SymbolIndexError> {
        self.index.reconcile_overlay()
    }

    fn observe_source_generation(&self) -> Result<(), SymbolIndexRuntimeError> {
        let source_generation = self
            .source_index
            .snapshot()
            .map_err(SymbolIndexRuntimeError::SourceIndex)?
            .generation;
        let symbol_snapshot = self
            .index
            .snapshot()
            .map_err(SymbolIndexRuntimeError::Index)?;
        if symbol_snapshot.generation > 0 && symbol_snapshot.source_generation != source_generation
        {
            *self
                .state
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                SymbolIndexRuntimeState::Stale(symbol_snapshot);
        }
        Ok(())
    }

    fn publish_ready(&self, snapshot: SymbolIndexSnapshot) {
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            SymbolIndexRuntimeState::Ready(snapshot);
    }
}

#[derive(Debug)]
pub(super) enum SymbolIndexRuntimeError {
    NotReady,
    SourceIndex(ash_codebase::CodebaseError),
    Index(SymbolIndexError),
}

fn ready_snapshot(state: &SymbolIndexRuntimeState) -> Option<SymbolIndexSnapshot> {
    match state {
        SymbolIndexRuntimeState::Ready(snapshot) | SymbolIndexRuntimeState::Stale(snapshot) => {
            Some(snapshot.clone())
        }
        SymbolIndexRuntimeState::Indexing { last_ready } => last_ready.clone(),
        SymbolIndexRuntimeState::Empty | SymbolIndexRuntimeState::Failed => None,
    }
}

#[cfg(test)]
#[path = "symbol_index_runtime_tests.rs"]
mod tests;
