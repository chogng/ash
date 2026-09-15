use super::FastRegexSearch;
use super::IndexState;
use super::IndexedDocument;
use super::io_error;
use super::snapshot;
use super::sort::Sorter;
use crate::FastRegexError;
use crate::FastRegexSearchSnapshot;
use crate::FastRegexSearchStorage;
use crate::dir_files::dir_walk_builder;
use crate::dir_files::scan_dir;
use crate::file_stamp::FileStamp;
use crate::storage;
use crate::trigram;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

impl FastRegexSearch {
    pub fn rebuild(&self) -> Result<FastRegexSearchSnapshot, FastRegexError> {
        let mut next = IndexState::default();
        let mut sorter = match &self.storage {
            FastRegexSearchStorage::Memory => None,
            FastRegexSearchStorage::Persistent(path) => {
                Some(Sorter::new(path).map_err(|e| io_error(path, e))?)
            }
        };
        scan_dir(&self.root, &self.limits, |path, content, stamp| {
            if let Some(sorter) = &mut sorter {
                let mut document = prepare_document(next.next_document_id, &content, stamp);
                sorter
                    .push(document.id, &document.grams)
                    .map_err(|e| io_error(self.root.canonical_path(), e))?;
                document.grams = Vec::new();
                insert_prepared(&mut next, path, document);
            } else {
                insert_document(&mut next, path, content, stamp);
            }
            Ok(())
        })?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        next.generation = state.generation.saturating_add(1);
        next.base_generation = next.generation;
        next.overlays = state.overlays.clone();
        let mut post_commit_error = None;
        if let FastRegexSearchStorage::Persistent(path) = &self.storage {
            let sorted = sorter
                .expect("persistent build has a sorter")
                .finish()
                .map_err(|e| io_error(path, e))?;
            post_commit_error = storage::persist_sorted(path, &next, state.generation, sorted)?;
            let mut loaded = storage::load(&self.storage)?
                .ok_or_else(|| FastRegexError::CorruptIndex(path.clone()))?;
            loaded.overlays = next.overlays;
            next = loaded;
        }
        *state = next;
        *self
            .ignore_matcher
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            dir_walk_builder(self.root.canonical_path())
                .build_matchers()
                .into_iter()
                .next()
                .expect("directory walk has exactly one root");
        let snapshot = snapshot(&state);
        if let Some(error) = post_commit_error {
            return Err(error);
        }
        Ok(snapshot)
    }
}

pub(super) fn insert_document(
    state: &mut IndexState,
    path: PathBuf,
    content: String,
    stamp: FileStamp,
) {
    let document = prepare_document(state.next_document_id, &content, stamp);
    for gram in &document.grams {
        // Each file contributes a gram once, and IDs increase monotonically.
        state
            .postings
            .entry(trigram::key(*gram))
            .or_default()
            .push(trigram::posting(document.id, trigram::mask(*gram)));
    }
    insert_prepared(state, path, document);
}

fn prepare_document(id: u32, content: &str, stamp: FileStamp) -> IndexedDocument {
    let folded = content
        .as_bytes()
        .iter()
        .map(u8::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let grams = trigram::extract(&folded);
    IndexedDocument {
        id,
        revision: revision(content),
        source_bytes: content.len(),
        stamp,
        grams,
    }
}

fn insert_prepared(state: &mut IndexState, path: PathBuf, document: IndexedDocument) {
    let id = document.id;
    state.next_document_id = state.next_document_id.saturating_add(1);
    state.source_bytes = state.source_bytes.saturating_add(document.source_bytes);
    state.document_paths.insert(id, path.clone());
    state.documents.insert(path, document);
}

pub(super) fn remove_document(state: &mut IndexState, path: &Path) -> bool {
    let Some(document) = state.documents.remove(path) else {
        return false;
    };
    state.source_bytes = state.source_bytes.saturating_sub(document.source_bytes);
    state.document_paths.remove(&document.id);
    remove_postings(&mut state.postings, document.id, &document.grams);
    true
}

fn remove_postings(postings: &mut HashMap<u64, Vec<u64>>, id: u32, grams: &[u64]) {
    for gram in grams {
        if let Some(ids) = postings.get_mut(&trigram::key(*gram)) {
            if let Ok(position) =
                ids.binary_search_by_key(&id, |entry| trigram::document_id(*entry))
            {
                ids.remove(position);
            }
            if ids.is_empty() {
                postings.remove(&trigram::key(*gram));
            }
        }
    }
}

pub(super) fn revision(content: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(content.as_bytes());
    format!("sha256:{:x}", digest.finalize())
}
