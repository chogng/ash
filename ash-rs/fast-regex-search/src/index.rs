use crate::FastRegexCaseSensitivity;
use crate::FastRegexError;
use crate::FastRegexMatch;
use crate::FastRegexPattern;
use crate::FastRegexQuery;
use crate::FastRegexRange;
use crate::FastRegexSearchLimits;
use crate::FastRegexSearchResult;
use crate::FastRegexSearchSnapshot;
use crate::FastRegexSearchStatistics;
use crate::FastRegexSearchStorage;
use crate::FastRegexUpdateOutcome;
use crate::dir_files::dir_walk_builder;
use crate::dir_files::read_text_file;
use crate::dir_files::read_text_file_with_stamp;
use crate::dir_files::scan_dir;
use crate::dir_files::scan_dir_stamps;
use crate::disk_index::DiskBaseIndex;
use crate::file_stamp::FileStamp;
use crate::ngram::covering_ngrams;
use crate::ngram::sparse_ngrams;
use crate::query::Plan;
use crate::storage;
use ash_file_access::Dir;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use regex::Regex;
use regex::RegexBuilder;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::thread;

const DELTA_COMPACTION_MIN_PATHS: usize = 128;
const DELTA_COMPACTION_MAX_PATHS: usize = 4_096;

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
    pub(crate) postings: HashMap<u64, BTreeSet<u32>>,
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

    pub fn rebuild(&self) -> Result<FastRegexSearchSnapshot, FastRegexError> {
        let prepared = scan_dir(&self.root, &self.limits)?;
        let mut next = IndexState::default();
        for (path, content, stamp) in prepared {
            insert_document(&mut next, path, content, stamp);
        }
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        next.generation = state.generation.saturating_add(1);
        next.base_generation = next.generation;
        next.overlays = state.overlays.clone();
        let post_commit_error = storage::persist(&self.storage, &next, state.generation)?;
        let mut reload_error = None;
        if let FastRegexSearchStorage::Persistent(path) = &self.storage {
            match storage::load(&self.storage) {
                Ok(Some(mut loaded)) => {
                    loaded.overlays = next.overlays;
                    next = loaded;
                }
                Ok(None) => reload_error = Some(FastRegexError::CorruptIndex(path.clone())),
                Err(error) => reload_error = Some(error),
            }
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
        if let Some(error) = reload_error {
            return Err(error);
        }
        if let Some(error) = post_commit_error {
            return Err(error);
        }
        Ok(snapshot)
    }

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

    /// Searches the published corpus plus overlays. Callers apply observed changes before
    /// searching; unobserved files cannot be detected by candidate-only verification.
    /// The result identifies the generation used, not a filesystem freshness guarantee.
    pub fn search(&self, query: &FastRegexQuery) -> Result<FastRegexSearchResult, FastRegexError> {
        validate_query(query, &self.limits)?;
        let sensitive = case_sensitive(query);
        let matcher = compile_matcher(query, sensitive)?;
        let filters = PathFilters::new(
            &query.scope,
            &query.include_patterns,
            &query.exclude_patterns,
        )?;
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        if state.generation == 0 {
            return Err(FastRegexError::NotReady);
        }
        let expression = match query.pattern {
            FastRegexPattern::Literal => regex::escape(&query.query),
            FastRegexPattern::Regex => query.query.clone(),
        };
        let plan = crate::query::plan(&expression, sensitive)?;
        let candidates = candidate_paths(&state, &plan)?;
        let candidate_file_count = candidates.len();
        let paths = candidates
            .into_iter()
            .filter(|path| filters.matches(path))
            .collect::<Vec<_>>();
        let batches = if paths.len() >= 128 && query.max_results >= 256 {
            let workers = thread::available_parallelism()
                .map_or(1, usize::from)
                .min(8)
                .min(paths.len().div_ceil(64));
            thread::scope(|scope| {
                let jobs = paths
                    .chunks(paths.len().div_ceil(workers))
                    .map(|paths| {
                        let matcher = matcher.clone();
                        let state = &*state;
                        scope.spawn(move || {
                            self.verify_candidates(state, paths, &matcher, query.max_results)
                        })
                    })
                    .collect::<Vec<_>>();
                jobs.into_iter()
                    .map(|job| job.join().expect("candidate verification thread panicked"))
                    .collect::<Result<Vec<_>, _>>()
            })?
        } else {
            vec![self.verify_candidates(&state, &paths, &matcher, query.max_results)?]
        };
        let mut matches = Vec::new();
        let mut limit_hit = false;
        let mut scanned_file_count = 0;
        for batch in batches {
            scanned_file_count += batch.scanned;
            let remaining = query.max_results.saturating_sub(matches.len());
            limit_hit |= batch.limit_hit || batch.matches.len() > remaining;
            matches.extend(batch.matches.into_iter().take(remaining));
        }
        Ok(FastRegexSearchResult {
            matches,
            limit_hit,
            statistics: FastRegexSearchStatistics {
                generation: state.generation,
                indexed_file_count: state.documents.len(),
                candidate_file_count,
                scanned_file_count,
            },
        })
    }

    fn verify_candidates(
        &self,
        state: &IndexState,
        paths: &[PathBuf],
        matcher: &Regex,
        limit: usize,
    ) -> Result<SearchBatch, FastRegexError> {
        let mut batch = SearchBatch::default();
        for path in paths {
            batch.scanned += 1;
            let content = if let Some(content) = state.overlays.get(path) {
                content.clone()
            } else {
                let Some(document) = state.documents.get(path) else {
                    continue;
                };
                let absolute = self.root.canonical_path().join(path);
                let Some(content) = read_text_file(&absolute, self.limits.max_file_bytes)? else {
                    return Err(FastRegexError::StaleSource(path.clone()));
                };
                if revision(&content) != document.revision {
                    return Err(FastRegexError::StaleSource(path.clone()));
                }
                content
            };
            collect_matches(
                path,
                &content,
                matcher,
                limit,
                &mut batch.matches,
                &mut batch.limit_hit,
            );
            if batch.limit_hit {
                break;
            }
        }
        Ok(batch)
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

#[derive(Default)]
struct SearchBatch {
    matches: Vec<FastRegexMatch>,
    limit_hit: bool,
    scanned: usize,
}

fn insert_document(state: &mut IndexState, path: PathBuf, content: String, stamp: FileStamp) {
    let id = state.next_document_id;
    state.next_document_id = state.next_document_id.saturating_add(1);
    let folded = content
        .as_bytes()
        .iter()
        .map(u8::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let grams = sparse_ngrams(&folded);
    for gram in &grams {
        state.postings.entry(*gram).or_default().insert(id);
    }
    state.source_bytes = state.source_bytes.saturating_add(content.len());
    state.document_paths.insert(id, path.clone());
    state.documents.insert(
        path,
        IndexedDocument {
            id,
            revision: revision(&content),
            source_bytes: content.len(),
            stamp,
            grams,
        },
    );
}

fn remove_document(state: &mut IndexState, path: &Path) -> bool {
    let Some(document) = state.documents.remove(path) else {
        return false;
    };
    state.source_bytes = state.source_bytes.saturating_sub(document.source_bytes);
    state.document_paths.remove(&document.id);
    remove_postings(&mut state.postings, document.id, &document.grams);
    true
}

fn remove_postings(postings: &mut HashMap<u64, BTreeSet<u32>>, id: u32, grams: &[u64]) {
    for gram in grams {
        if let Some(ids) = postings.get_mut(gram) {
            ids.remove(&id);
            if ids.is_empty() {
                postings.remove(gram);
            }
        }
    }
}

fn candidate_paths(state: &IndexState, plan: &Plan) -> Result<BTreeSet<PathBuf>, FastRegexError> {
    let mut candidates = candidates_for_plan(state, plan)?
        .unwrap_or_else(|| state.documents.keys().cloned().collect());
    // Unsaved contents are outside the persistent corpus. Always verify them;
    // stale on-disk postings must never exclude an overlay.
    candidates.extend(state.overlays.keys().cloned());
    Ok(candidates)
}

fn candidates_for_plan(
    state: &IndexState,
    plan: &Plan,
) -> Result<Option<BTreeSet<PathBuf>>, FastRegexError> {
    match plan {
        Plan::All => Ok(None),
        Plan::Literal(literal) => candidates_for_literal(state, literal),
        Plan::And(plans) => {
            let mut intersection: Option<BTreeSet<PathBuf>> = None;
            for plan in plans {
                if let Some(next) = candidates_for_plan(state, plan)? {
                    if let Some(current) = &mut intersection {
                        current.retain(|path| next.contains(path));
                    } else {
                        intersection = Some(next);
                    }
                    if intersection.as_ref().is_some_and(BTreeSet::is_empty) {
                        break;
                    }
                }
            }
            Ok(intersection)
        }
        Plan::Or(plans) => {
            let mut union = BTreeSet::new();
            for plan in plans {
                match candidates_for_plan(state, plan)? {
                    Some(next) => union.extend(next),
                    None => return Ok(None),
                }
            }
            Ok(Some(union))
        }
    }
}

fn candidates_for_literal(
    state: &IndexState,
    literal: &[u8],
) -> Result<Option<BTreeSet<PathBuf>>, FastRegexError> {
    let grams = covering_ngrams(literal);
    if grams.is_empty() {
        return Ok(None);
    }
    let mut intersection = state
        .disk_base
        .as_ref()
        .map(|base| base.intersect_postings(&grams, &state.dirty_paths))
        .transpose()?
        .unwrap_or_default();
    let postings = &state.postings;
    let mut lists = Vec::with_capacity(grams.len());
    for gram in &grams {
        let Some(paths) = postings.get(gram) else {
            lists.clear();
            break;
        };
        lists.push(paths);
    }
    if !lists.is_empty() {
        lists.sort_by_key(|paths| paths.len());
        let mut in_memory = lists[0].clone();
        for ids in &lists[1..] {
            in_memory.retain(|id| ids.contains(id));
            if in_memory.is_empty() {
                break;
            }
        }
        intersection.extend(
            in_memory
                .into_iter()
                .filter_map(|id| state.document_paths.get(&id).cloned()),
        );
    }
    Ok(Some(intersection))
}

fn compile_matcher(query: &FastRegexQuery, sensitive: bool) -> Result<Regex, FastRegexError> {
    let expression = match query.pattern {
        FastRegexPattern::Literal => regex::escape(&query.query),
        FastRegexPattern::Regex => query.query.clone(),
    };
    RegexBuilder::new(&expression)
        .case_insensitive(!sensitive)
        .multi_line(false)
        .build()
        .map_err(FastRegexError::from)
}

fn case_sensitive(query: &FastRegexQuery) -> bool {
    match query.case_sensitivity {
        FastRegexCaseSensitivity::Sensitive => true,
        FastRegexCaseSensitivity::Insensitive => false,
        FastRegexCaseSensitivity::Smart => query.query.chars().any(char::is_uppercase),
    }
}

fn collect_matches(
    path: &Path,
    content: &str,
    matcher: &Regex,
    limit: usize,
    output: &mut Vec<FastRegexMatch>,
    limit_hit: &mut bool,
) {
    for (line_index, preview) in content.split_terminator('\n').enumerate() {
        let ranges = matcher
            .find_iter(preview)
            .map(|found| FastRegexRange {
                start_byte: found.start(),
                end_byte: found.end(),
            })
            .collect::<Vec<_>>();
        if ranges.is_empty() {
            continue;
        }
        if output.len() == limit {
            *limit_hit = true;
            return;
        }
        output.push(FastRegexMatch {
            path: path.to_path_buf(),
            line_number: line_index + 1,
            preview: preview.to_owned(),
            ranges,
        });
    }
}

struct PathFilters {
    scope: PathBuf,
    includes: Option<GlobSet>,
    excludes: GlobSet,
}

impl PathFilters {
    fn new(scope: &Path, includes: &[String], excludes: &[String]) -> Result<Self, FastRegexError> {
        Ok(Self {
            scope: scope.to_path_buf(),
            includes: (!includes.is_empty())
                .then(|| build_glob_set(includes))
                .transpose()?,
            excludes: build_glob_set(excludes)?,
        })
    }

    fn matches(&self, path: &Path) -> bool {
        (self.scope.as_os_str().is_empty() || path.starts_with(&self.scope))
            && self.includes.as_ref().is_none_or(|set| set.is_match(path))
            && !self.excludes.is_match(path)
    }
}

fn build_glob_set(patterns: &[String]) -> Result<GlobSet, FastRegexError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let pattern = if pattern.contains('/') || pattern.contains('\\') {
            pattern.clone()
        } else {
            format!("**/{pattern}")
        };
        let glob = GlobBuilder::new(&pattern)
            .literal_separator(true)
            .build()
            .map_err(|_| FastRegexError::InvalidGlob)?;
        builder.add(glob);
    }
    builder.build().map_err(|_| FastRegexError::InvalidGlob)
}

fn validate_query(
    query: &FastRegexQuery,
    limits: &FastRegexSearchLimits,
) -> Result<(), FastRegexError> {
    if query.query.is_empty()
        || query.query.len() > limits.max_query_bytes
        || query.query.contains('\0')
    {
        return Err(FastRegexError::InvalidQuery("search query is invalid"));
    }
    if query.max_results == 0 || query.max_results > limits.max_results {
        return Err(FastRegexError::InvalidQuery(
            "search result limit is invalid",
        ));
    }
    validate_scope(&query.scope)?;
    PathFilters::new(
        &query.scope,
        &query.include_patterns,
        &query.exclude_patterns,
    )?;
    Ok(())
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

fn validate_scope(path: &Path) -> Result<(), FastRegexError> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(FastRegexError::InvalidQuery("search scope is invalid"));
    }
    Ok(())
}

fn is_ignore_control(path: &Path) -> bool {
    path == Path::new(".git/info/exclude")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, ".gitignore" | ".ignore" | ".gitmodules"))
}

fn revision(content: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(content.as_bytes());
    format!("sha256:{:x}", digest.finalize())
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
