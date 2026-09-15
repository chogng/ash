use crate::FastRegexError;
use crate::FastRegexSearchLimits;
use crate::FastRegexSearchSnapshot;
use crate::FastRegexSearchStorage;
use crate::dir_files::dir_walk_builder;
use crate::disk_index::DiskBaseIndex;
use crate::file_stamp::FileStamp;
use crate::storage;
use ash_file_access::Dir;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

mod builder;
mod search;
mod sort;
mod update;
pub(crate) use sort::SortedPostings;

pub struct FastRegexSearch {
    root: Dir,
    storage: FastRegexSearchStorage,
    limits: FastRegexSearchLimits,
    ignore_matcher: Mutex<ignore::IncrementalIgnore>,
    state: RwLock<IndexState>,
}

#[derive(Clone, Default)]
pub(crate) struct IndexState {
    pub(crate) generation: u64,
    pub(crate) base_generation: u64,
    pub(crate) source_bytes: usize,
    pub(crate) documents: BTreeMap<PathBuf, IndexedDocument>,
    pub(crate) document_paths: BTreeMap<u32, PathBuf>,
    pub(crate) next_document_id: u32,
    pub(crate) postings: HashMap<u64, Vec<u64>>,
    pub(crate) overlays: BTreeMap<PathBuf, String>,
    pub(crate) dirty_paths: BTreeSet<PathBuf>,
    pub(crate) disk_base: Option<Arc<DiskBaseIndex>>,
    pub(crate) requires_rebuild: bool,
}

#[derive(Clone)]
pub(crate) struct IndexedDocument {
    pub(crate) id: u32,
    pub(crate) revision: String,
    pub(crate) source_bytes: usize,
    pub(crate) stamp: FileStamp,
    pub(crate) grams: Vec<u64>,
}

impl FastRegexSearch {
    pub fn open(
        root: Dir,
        storage: FastRegexSearchStorage,
        limits: FastRegexSearchLimits,
    ) -> Result<Self, FastRegexError> {
        if limits.max_files == 0
            || limits.max_file_bytes == 0
            || limits.max_total_source_bytes < limits.max_file_bytes
            || limits.max_query_bytes == 0
            || limits.max_results == 0
        {
            return Err(FastRegexError::InvalidLimits);
        }
        if let FastRegexSearchStorage::Persistent(path) = &storage {
            fs::create_dir_all(path).map_err(|source| io_error(path, source))?;
        }
        let ignore_matcher = dir_walk_builder(root.canonical_path())
            .build_matchers()
            .into_iter()
            .next()
            .expect("directory walk has exactly one root");
        let state = storage::load(&storage)?.unwrap_or_default();
        limits.check_capacity(state.documents.len(), state.source_bytes)?;
        let requires_rebuild = state.requires_rebuild;
        let search = Self {
            root,
            storage,
            limits,
            ignore_matcher: Mutex::new(ignore_matcher),
            state: RwLock::new(state),
        };
        if requires_rebuild {
            search.rebuild()?;
        } else if search.snapshot().generation != 0 {
            search.reconcile_dir()?;
        }
        Ok(search)
    }

    pub fn root(&self) -> &Dir {
        &self.root
    }

    pub fn snapshot(&self) -> FastRegexSearchSnapshot {
        snapshot(&self.state.read().unwrap_or_else(|error| error.into_inner()))
    }

    pub fn synchronize_overlay(
        &self,
        path: PathBuf,
        content: String,
    ) -> Result<(), FastRegexError> {
        validate_relative_path(&path)?;
        if content.len() > self.limits.max_file_bytes {
            return Err(FastRegexError::InvalidQuery(
                "overlay exceeds the file byte limit",
            ));
        }
        self.state
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .overlays
            .insert(path, content);
        Ok(())
    }

    pub fn close_overlay(&self, path: &Path) -> Result<(), FastRegexError> {
        validate_relative_path(path)?;
        self.state
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .overlays
            .remove(path);
        Ok(())
    }
}

fn validate_relative_path(path: &Path) -> Result<(), FastRegexError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(FastRegexError::InvalidQuery("overlay path is invalid"));
    }
    Ok(())
}

fn snapshot(state: &IndexState) -> FastRegexSearchSnapshot {
    FastRegexSearchSnapshot {
        generation: state.generation,
        indexed_file_count: state.documents.len(),
        indexed_source_bytes: state.source_bytes,
    }
}

fn io_error(path: &Path, source: std::io::Error) -> FastRegexError {
    FastRegexError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
#[path = "index_tests.rs"]
mod tests;
