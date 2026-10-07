//! SQLite persistence adapters for the Codebase capability.

mod semantic;
mod source;
mod source_manifest;
mod symbol;

use std::path::PathBuf;
use std::sync::Arc;

use ash_codebase::{
    Codebase, CodebaseError, CodebaseLimits, CodebaseVectorStoreError, IndexRootId, SymbolIndex,
    SymbolIndexError, SymbolIndexLimits,
};
use ash_file_access::Dir;
use ash_file_access::DirId;
use ash_state::{DirIndexKind, DirIndexLease, StateRuntime};

use semantic::SqliteCodebaseVectorStore;
use source::SqliteCodebaseIndexStore;
use symbol::SqliteSymbolIndexStore;

/// Physical placement for rebuildable Codebase SQLite data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CodebaseStoreStorage {
    Memory,
    Persistent(PathBuf),
}

/// One directory-scoped owner of the Codebase database and its lifecycle lock.
pub struct CodebaseStore {
    storage: CodebaseStoreStorage,
    _lease: Option<DirIndexLease>,
}

impl CodebaseStore {
    pub fn memory() -> Self {
        Self {
            storage: CodebaseStoreStorage::Memory,
            _lease: None,
        }
    }

    pub fn open(state: &StateRuntime, dir: &DirId) -> std::io::Result<Self> {
        let lease = state.acquire(dir, DirIndexKind::Codebase)?;
        Ok(Self {
            storage: CodebaseStoreStorage::Persistent(lease.directory().join("codebase.sqlite3")),
            _lease: Some(lease),
        })
    }

    pub fn database_path(&self) -> Option<&std::path::Path> {
        match &self.storage {
            CodebaseStoreStorage::Memory => None,
            CodebaseStoreStorage::Persistent(path) => Some(path),
        }
    }

    pub fn open_codebase(
        &self,
        root: Dir,
        limits: CodebaseLimits,
    ) -> Result<Codebase, CodebaseError> {
        let root_id = IndexRootId::from_root(&root);
        let store = Arc::new(SqliteCodebaseIndexStore::open(&self.storage, &root_id)?);
        Codebase::open(root, store, limits)
    }

    pub fn open_symbol_index(
        &self,
        codebase: Arc<Codebase>,
        limits: SymbolIndexLimits,
    ) -> Result<SymbolIndex, SymbolIndexError> {
        let store = Arc::new(SqliteSymbolIndexStore::open(
            &self.storage,
            codebase.root_id(),
        )?);
        SymbolIndex::open(codebase, store, limits)
    }

    pub fn open_vector_store(
        &self,
    ) -> Result<Arc<dyn ash_codebase::CodebaseVectorStore>, CodebaseVectorStoreError> {
        Ok(Arc::new(SqliteCodebaseVectorStore::open(&self.storage)?))
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
