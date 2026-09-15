use super::FastRegexSearch;
use super::IndexState;
use super::builder::insert_document;
use super::builder::remove_document;
use super::builder::revision;
use super::snapshot;
use crate::FastRegexError;
use crate::FastRegexSearchStorage;
use crate::FastRegexUpdateOutcome;
use crate::dir_files::dir_walk_builder;
use crate::dir_files::read_text_file_with_stamp;
use crate::dir_files::scan_dir_stamps;
use crate::storage;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

pub(super) const DELTA_COMPACTION_MIN_PATHS: usize = 128;
const DELTA_COMPACTION_MAX_PATHS: usize = 4_096;

impl FastRegexSearch {
    pub fn refresh_observed_paths(
        &self,
        observed_paths: &[PathBuf],
    ) -> Result<FastRegexUpdateOutcome, FastRegexError> {
        let mut paths = observed_paths
            .iter()
            .filter_map(|path| self.root.project_observed_path(path))
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        if paths.is_empty() {
            return Ok(FastRegexUpdateOutcome::NoChange);
        }
        if paths.iter().any(|path| {
            path.as_os_str().is_empty()
                || is_ignore_control(path)
                || self.root.canonical_path().join(path).is_dir()
        }) {
            return self.reconcile_dir();
        }
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let expected_generation = state.generation;
        let mut next = state.clone();
        let mut changed = false;
        for path in paths {
            let absolute = self.root.canonical_path().join(&path);
            if !absolute.is_file() {
                if remove_document(&mut next, &path) {
                    next.dirty_paths.insert(path);
                    changed = true;
                }
                continue;
            }
            if !next.documents.contains_key(&path) {
                if !self.is_indexable_path(&path) {
                    continue;
                }
                let Some((content, stamp)) =
                    read_text_file_with_stamp(&absolute, self.limits.max_file_bytes)?
                else {
                    continue;
                };
                self.limits.check_capacity(
                    next.documents.len() + 1,
                    next.source_bytes.saturating_add(content.len()),
                )?;
                insert_document(&mut next, path.clone(), content, stamp);
                next.dirty_paths.insert(path);
                changed = true;
                continue;
            }
            match read_text_file_with_stamp(&absolute, self.limits.max_file_bytes)? {
                Some((content, stamp)) => {
                    let current_revision = revision(&content);
                    if next
                        .documents
                        .get(&path)
                        .is_some_and(|document| document.revision == current_revision)
                    {
                        continue;
                    }
                    let previous_bytes = next
                        .documents
                        .get(&path)
                        .map_or(0, |document| document.source_bytes);
                    self.limits.check_capacity(
                        next.documents.len(),
                        next.source_bytes
                            .saturating_sub(previous_bytes)
                            .saturating_add(content.len()),
                    )?;
                    remove_document(&mut next, &path);
                    insert_document(&mut next, path.clone(), content, stamp);
                    next.dirty_paths.insert(path);
                    changed = true;
                }
                None => {
                    if remove_document(&mut next, &path) {
                        next.dirty_paths.insert(path);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            return Ok(FastRegexUpdateOutcome::NoChange);
        }
        if self.should_compact_delta(&next) {
            drop(state);
            return self.rebuild().map(FastRegexUpdateOutcome::Rebuilt);
        }
        next.generation = next.generation.saturating_add(1);
        let post_commit_error = storage::persist_delta(&self.storage, &next, expected_generation)?;
        let published = FastRegexUpdateOutcome::Published(snapshot(&next));
        *state = next;
        if let Some(error) = post_commit_error {
            return Err(error);
        }
        Ok(published)
    }

    fn is_indexable_path(&self, relative: &Path) -> bool {
        !self
            .ignore_matcher
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .matched(relative, false)
            .is_ignore()
    }

    pub fn reconcile_dir(&self) -> Result<FastRegexUpdateOutcome, FastRegexError> {
        let current = scan_dir_stamps(&self.root, &self.limits)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let expected_generation = state.generation;
        let mut next = state.clone();
        let mut paths = next.documents.keys().cloned().collect::<BTreeSet<_>>();
        paths.extend(current.keys().cloned());
        let mut changed = false;
        for path in paths {
            let Some(stamp) = current.get(&path).copied() else {
                if remove_document(&mut next, &path) {
                    next.dirty_paths.insert(path);
                    changed = true;
                }
                continue;
            };
            if next
                .documents
                .get(&path)
                .is_some_and(|document| document.stamp == stamp)
            {
                continue;
            }
            let absolute = self.root.canonical_path().join(&path);
            let content = read_text_file_with_stamp(&absolute, self.limits.max_file_bytes)?;
            if next.documents.contains_key(&path) {
                remove_document(&mut next, &path);
                next.dirty_paths.insert(path.clone());
                changed = true;
            }
            let Some((content, stamp)) = content else {
                continue;
            };
            self.limits.check_capacity(
                next.documents.len() + 1,
                next.source_bytes.saturating_add(content.len()),
            )?;
            insert_document(&mut next, path.clone(), content, stamp);
            next.dirty_paths.insert(path);
            changed = true;
        }
        if self.should_compact_delta(&next) {
            drop(state);
            return self.rebuild().map(FastRegexUpdateOutcome::Rebuilt);
        } else if changed {
            next.generation = next.generation.saturating_add(1);
            let post_commit_error =
                storage::persist_delta(&self.storage, &next, expected_generation)?;
            let outcome = FastRegexUpdateOutcome::Published(snapshot(&next));
            *state = next;
            self.refresh_ignore_matcher();
            if let Some(error) = post_commit_error {
                return Err(error);
            }
            return Ok(outcome);
        }
        self.refresh_ignore_matcher();
        Ok(FastRegexUpdateOutcome::NoChange)
    }

    fn refresh_ignore_matcher(&self) {
        *self
            .ignore_matcher
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            dir_walk_builder(self.root.canonical_path())
                .build_matchers()
                .into_iter()
                .next()
                .expect("directory walk has exactly one root");
    }

    fn should_compact_delta(&self, state: &IndexState) -> bool {
        if !matches!(&self.storage, FastRegexSearchStorage::Persistent(_)) {
            return false;
        }
        let dirty = state.dirty_paths.len();
        dirty >= DELTA_COMPACTION_MAX_PATHS
            || (dirty >= DELTA_COMPACTION_MIN_PATHS
                && dirty.saturating_mul(5) >= state.documents.len().max(1))
    }
}

fn is_ignore_control(path: &Path) -> bool {
    path == Path::new(".git/info/exclude")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, ".gitignore" | ".ignore" | ".gitmodules"))
}
