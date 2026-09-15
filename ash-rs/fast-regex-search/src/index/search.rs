use super::FastRegexSearch;
use super::IndexState;
use super::builder::revision;
use crate::FastRegexCaseSensitivity;
use crate::FastRegexError;
use crate::FastRegexMatch;
use crate::FastRegexPattern;
use crate::FastRegexQuery;
use crate::FastRegexRange;
use crate::FastRegexSearchLimits;
use crate::FastRegexSearchResult;
use crate::FastRegexSearchStatistics;
use crate::dir_files::read_text_file;
use crate::query::Plan;
use crate::trigram;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use regex::Regex;
use regex::RegexBuilder;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::thread;

impl FastRegexSearch {
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
}

#[derive(Default)]
struct SearchBatch {
    matches: Vec<FastRegexMatch>,
    limit_hit: bool,
    scanned: usize,
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
    let grams = trigram::extract(literal);
    if grams.is_empty() {
        return Ok(None);
    }
    let mut intersection = state
        .disk_base
        .as_ref()
        .map(|base| base.intersect_postings(&grams, &state.dirty_paths))
        .transpose()?
        .unwrap_or_default();
    let mut lists = Vec::with_capacity(grams.len());
    for gram in &grams {
        let Some(entries) = state.postings.get(&trigram::key(*gram)) else {
            lists.clear();
            break;
        };
        lists.push((entries, trigram::mask(*gram)));
    }
    if !lists.is_empty() {
        lists.sort_by_key(|(entries, _)| entries.len());
        let (first, required) = lists[0];
        let mut ids = first
            .iter()
            .copied()
            .filter(|entry| trigram::accepts(*entry, required))
            .map(trigram::document_id)
            .collect::<Vec<_>>();
        for (entries, required) in &lists[1..] {
            ids.retain(|id| {
                entries
                    .binary_search_by_key(id, |entry| trigram::document_id(*entry))
                    .is_ok_and(|position| trigram::accepts(entries[position], *required))
            });
            if ids.is_empty() {
                break;
            }
        }
        intersection.extend(
            ids.into_iter()
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

pub(super) fn collect_matches(
    path: &Path,
    content: &str,
    matcher: &Regex,
    limit: usize,
    output: &mut Vec<FastRegexMatch>,
    limit_hit: &mut bool,
) {
    // UTF-8 BOM describes the file encoding; rg does not expose it as the
    // first character of the first line. Keep it in source hashing/indexing.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
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
