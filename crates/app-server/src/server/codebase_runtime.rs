use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use ash_codebase::Codebase;
use ash_codebase::CodebaseError;
use ash_codebase::CodebaseLimits;
use ash_codebase::CodebaseQuery;
use ash_codebase::CodebaseSnapshot;
use ash_codebase::RefreshOutcome;
use ash_codebase::SearchHit;
use ash_codebase_store::CodebaseStore;
use ash_file_access::Dir;
use ash_file_watcher::FileWatcherEvent;

/// App Server-owned lifecycle for one directory Codebase.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CodebaseRuntimeState {
    Empty,
    Indexing {
        last_ready: Option<CodebaseSnapshot>,
    },
    Ready(CodebaseSnapshot),
    Stale(CodebaseSnapshot),
    Failed,
}

pub(super) struct CodebaseRuntime {
    index: Arc<Codebase>,
    retrieval: ash_codebase::CodebaseRetrievalService,
    operation: Mutex<()>,
    state: RwLock<CodebaseRuntimeState>,
    store: Arc<CodebaseStore>,
}

impl CodebaseRuntime {
    pub fn open(
        dir: Dir,
        store: Arc<CodebaseStore>,
        search: Option<Arc<dyn grep::Search>>,
    ) -> Result<Arc<Self>, CodebaseError> {
        let index = store.open_codebase(dir, CodebaseLimits::default())?;
        let index = Arc::new(index);
        let retrieval = ash_codebase::CodebaseRetrievalService::local(Arc::clone(&index));
        let retrieval = match search {
            Some(search) => retrieval.with_grep(search),
            None => retrieval,
        };
        let snapshot = index.snapshot()?;
        let state = if snapshot.generation == 0 {
            CodebaseRuntimeState::Empty
        } else {
            CodebaseRuntimeState::Stale(snapshot)
        };
        Ok(Arc::new(Self {
            index,
            retrieval,
            operation: Mutex::new(()),
            state: RwLock::new(state),
            store,
        }))
    }

    pub fn store(&self) -> Arc<CodebaseStore> {
        Arc::clone(&self.store)
    }

    pub fn root(&self) -> &Dir {
        self.index.root()
    }

    pub fn index(&self) -> Arc<Codebase> {
        Arc::clone(&self.index)
    }

    pub fn retrieval(&self) -> ash_codebase::CodebaseRetrievalService {
        self.retrieval.clone()
    }

    pub fn state(&self) -> CodebaseRuntimeState {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn rebuild(&self) -> Result<CodebaseSnapshot, CodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let last_ready = ready_snapshot(&self.state());
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = CodebaseRuntimeState::Indexing {
            last_ready: last_ready.clone(),
        };
        match self.index.rebuild() {
            Ok(snapshot) => {
                *self
                    .state
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    CodebaseRuntimeState::Ready(snapshot.clone());
                Ok(snapshot)
            }
            Err(error) => {
                let fallback =
                    last_ready.map_or(CodebaseRuntimeState::Failed, CodebaseRuntimeState::Stale);
                *self
                    .state
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = fallback;
                Err(error)
            }
        }
    }

    pub fn apply_watcher_event(&self, event: &FileWatcherEvent) {
        let result = match event {
            FileWatcherEvent::PathsChanged { paths } => self.refresh_paths(paths),
            FileWatcherEvent::RescanRequired { .. } => self.rebuild().map(|_| ()),
        };
        if let Err(error) = result {
            log::warn!("codebase refresh failed: {error}");
        }
    }

    pub fn search(&self, query: &CodebaseQuery) -> Result<Vec<SearchHit>, CodebaseRuntimeError> {
        self.ensure_searchable()?;
        self.search_ready(query)
    }

    pub fn ensure_searchable(&self) -> Result<(), CodebaseRuntimeError> {
        match self.state() {
            CodebaseRuntimeState::Ready(_) | CodebaseRuntimeState::Stale(_) => Ok(()),
            CodebaseRuntimeState::Empty
            | CodebaseRuntimeState::Indexing { last_ready: None }
            | CodebaseRuntimeState::Failed => Err(CodebaseRuntimeError::NotReady),
            CodebaseRuntimeState::Indexing {
                last_ready: Some(_),
            } => Ok(()),
        }
    }

    fn search_ready(&self, query: &CodebaseQuery) -> Result<Vec<SearchHit>, CodebaseRuntimeError> {
        let hits = self
            .retrieval
            .search(query, &ash_async_utils::CancellationSource::new().token())
            .map_err(CodebaseRuntimeError::Retrieval)?;
        hits.into_iter()
            .map(|mut hit| {
                let materialized = self.index.materialize(&hit.reference).map_err(|error| {
                    if let Some(snapshot) = ready_snapshot(&self.state()) {
                        *self
                            .state
                            .write()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            CodebaseRuntimeState::Stale(snapshot);
                    }
                    CodebaseRuntimeError::Index(error)
                })?;
                hit.content = materialized.content;
                Ok(hit)
            })
            .collect()
    }

    fn refresh_paths(&self, paths: &[PathBuf]) -> Result<(), CodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_state = self.state();
        let last_ready = ready_snapshot(&previous_state);
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = CodebaseRuntimeState::Indexing {
            last_ready: last_ready.clone(),
        };
        match self.index.refresh_observed_paths(paths) {
            Ok(RefreshOutcome::NoChange) => {
                let restored = match self.state() {
                    CodebaseRuntimeState::Stale(snapshot) => CodebaseRuntimeState::Stale(snapshot),
                    _ => previous_state,
                };
                *self
                    .state
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = restored;
                Ok(())
            }
            Ok(RefreshOutcome::Published(snapshot) | RefreshOutcome::Rebuilt(snapshot)) => {
                *self
                    .state
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    CodebaseRuntimeState::Ready(snapshot);
                Ok(())
            }
            Err(error) => {
                if let Some(snapshot) = last_ready {
                    *self
                        .state
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        CodebaseRuntimeState::Stale(snapshot);
                } else {
                    *self
                        .state
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        CodebaseRuntimeState::Failed;
                }
                Err(error)
            }
        }
    }
}

#[derive(Debug)]
pub(super) enum CodebaseRuntimeError {
    NotReady,
    Index(CodebaseError),
    Retrieval(ash_codebase::CodebaseRetrievalError),
}

fn ready_snapshot(state: &CodebaseRuntimeState) -> Option<CodebaseSnapshot> {
    match state {
        CodebaseRuntimeState::Ready(snapshot) | CodebaseRuntimeState::Stale(snapshot) => {
            Some(snapshot.clone())
        }
        CodebaseRuntimeState::Indexing { last_ready } => last_ready.clone(),
        CodebaseRuntimeState::Empty | CodebaseRuntimeState::Failed => None,
    }
}

#[cfg(test)]
#[path = "codebase_runtime_tests.rs"]
mod tests;
