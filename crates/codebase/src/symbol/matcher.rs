use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::SourceSymbol;
use ash_async_utils::CancellationToken;
use nucleo::Config;
use nucleo::Matcher;
use nucleo::Nucleo;
use nucleo::Utf32String;
use nucleo::pattern::CaseMatching;
use nucleo::pattern::Normalization;
use nucleo::pattern::Pattern;

use crate::IndexedSourceReference;
use crate::IndexedSymbol;
use crate::SourceSymbols;
use crate::SymbolIndexError;
use crate::SymbolKind;
use crate::SymbolRange;
use crate::SymbolReference;
use crate::SymbolSearchHit;

const MATCH_TICK_MILLIS: u64 = 10;
const EXACT_MATCH_BOOST: u32 = 1_000_000;
const PREFIX_MATCH_BOOST: u32 = 100_000;

pub(crate) struct SymbolMatcher {
    nucleo: Nucleo<Candidate>,
    sources: Vec<IndexedSourceReference>,
    indices_matcher: Matcher,
}

// File identity is shared by all its declarations. Only bounded search results
// need the full, independently owned domain reference returned to callers.
struct Candidate {
    source: usize,
    ordinal: usize,
    // Nucleo may normalize Unicode graphemes. ASCII columns preserve the exact
    // original name, but non-ASCII names must retain their unmodified spelling.
    original_name: Option<Box<str>>,
    kind: SymbolKind,
    container_name: Option<Box<str>>,
    ranges: CandidateRanges,
}

// Common documents fit 32-bit coordinates. Keep a lossless wide representation
// for larger values rather than narrowing the domain contract or truncating.
enum CandidateRanges {
    Compact([u32; 12]),
    Wide(Box<[SymbolRange; 2]>),
}

impl CandidateRanges {
    fn new(declaration: SymbolRange, selection: SymbolRange) -> Self {
        let values = [&declaration, &selection].map(|r| {
            [
                r.start_byte,
                r.end_byte,
                r.start_line,
                r.start_column,
                r.end_line,
                r.end_column,
            ]
        });
        let mut compact = [0; 12];
        for (destination, value) in compact.iter_mut().zip(values.into_iter().flatten()) {
            let Ok(value) = u32::try_from(value) else {
                return Self::Wide(Box::new([declaration, selection]));
            };
            *destination = value;
        }
        Self::Compact(compact)
    }

    fn expand(&self) -> [SymbolRange; 2] {
        match self {
            Self::Compact(values) => [0, 6].map(|i| SymbolRange {
                start_byte: values[i] as usize,
                end_byte: values[i + 1] as usize,
                start_line: values[i + 2] as usize,
                start_column: values[i + 3] as usize,
                end_line: values[i + 4] as usize,
                end_column: values[i + 5] as usize,
            }),
            Self::Wide(ranges) => ranges.as_ref().clone(),
        }
    }
}

impl SymbolMatcher {
    pub fn new(sources: impl IntoIterator<Item = SourceSymbols>, worker_threads: usize) -> Self {
        let mut nucleo = Nucleo::new(Config::DEFAULT, Arc::new(|| {}), Some(worker_threads), 1);
        let injector = nucleo.injector();
        let mut shared_sources = Vec::new();
        for source in sources {
            let source_index = shared_sources.len();
            shared_sources.push(source.source);
            for symbol in source.symbols {
                let (candidate, matcher_name) = make_candidate(source_index, symbol);
                injector.push(candidate, move |_, columns| {
                    columns[0] = matcher_name;
                });
            }
        }
        while nucleo.tick(MATCH_TICK_MILLIS).running {}
        Self {
            nucleo,
            sources: shared_sources,
            indices_matcher: Matcher::new(Config::DEFAULT),
        }
    }

    pub fn search(
        &mut self,
        query: &str,
        result_limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SymbolSearchHit>, SymbolIndexError> {
        let candidates = self.candidates(
            query,
            candidate_limit(result_limit),
            cancellation,
            &BTreeSet::new(),
        )?;
        Ok(rank_candidates(candidates, query, result_limit))
    }

    pub(super) fn candidates(
        &mut self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
        excluded: &BTreeSet<PathBuf>,
    ) -> Result<Vec<SymbolMatch>, SymbolIndexError> {
        check_cancelled(cancellation)?;
        self.nucleo
            .pattern
            .reparse(0, query, CaseMatching::Ignore, Normalization::Smart, false);
        loop {
            check_cancelled(cancellation)?;
            if !self.nucleo.tick(MATCH_TICK_MILLIS).running {
                break;
            }
        }
        let snapshot = self.nucleo.snapshot();
        let pattern = snapshot.pattern().column_pattern(0);
        let sources = &self.sources;
        Ok(snapshot
            .matches()
            .iter()
            .filter_map(|matched| {
                let item = snapshot.get_item(matched.idx)?;
                (!excluded.contains(&sources[item.data.source].relative_path))
                    .then_some((matched, item))
            })
            .take(limit)
            .map(|(matched, item)| {
                make_match(
                    sources,
                    item.data,
                    &item.matcher_columns[0],
                    matched.score,
                    pattern,
                    &mut self.indices_matcher,
                )
            })
            .collect())
    }

    fn materialize(
        sources: &[IndexedSourceReference],
        candidate: &Candidate,
        name: String,
    ) -> IndexedSymbol {
        let source = &sources[candidate.source];
        let [declaration_range, selection_range] = candidate.ranges.expand();
        IndexedSymbol {
            reference: SymbolReference {
                root_id: source.root_id.clone(),
                relative_path: source.relative_path.clone(),
                source_revision: source.source_revision.clone(),
                language: source.language.clone(),
                source_bytes: source.source_bytes,
                ordinal: candidate.ordinal,
                declaration_range,
                selection_range,
            },
            name,
            kind: candidate.kind,
            container_name: candidate.container_name.as_deref().map(str::to_owned),
        }
    }
}

#[cfg(test)]
#[path = "matcher_tests.rs"]
mod tests;

pub(crate) fn sort_hits(hits: &mut [SymbolSearchHit]) {
    hits.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.symbol.name.cmp(&right.symbol.name))
            .then_with(|| {
                left.symbol
                    .reference
                    .relative_path
                    .cmp(&right.symbol.reference.relative_path)
            })
            .then_with(|| {
                left.symbol
                    .reference
                    .ordinal
                    .cmp(&right.symbol.reference.ordinal)
            })
    });
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), SymbolIndexError> {
    cancellation
        .check()
        .map_err(|signal| SymbolIndexError::Cancelled(signal.reason().to_string()))
}

fn make_candidate(source_index: usize, symbol: SourceSymbol) -> (Candidate, Utf32String) {
    let (original_name, matcher_name) = if symbol.name.is_ascii() && !symbol.name.contains("\r\n") {
        (None, Utf32String::from(symbol.name))
    } else {
        let original = symbol.name.into_boxed_str();
        let matcher_name = Utf32String::from(original.as_ref());
        (Some(original), matcher_name)
    };
    let candidate = Candidate {
        source: source_index,
        ordinal: symbol.ordinal,
        original_name,
        kind: symbol.kind,
        container_name: symbol.container_name.map(String::into_boxed_str),
        ranges: CandidateRanges::new(symbol.declaration_range, symbol.selection_range),
    };
    (candidate, matcher_name)
}

/// A bounded changed-file index uses the same scoring kernel without another thread pool.
pub(super) struct SymbolDeltaMatcher {
    sources: Vec<IndexedSourceReference>,
    items: Vec<(Candidate, Utf32String)>,
    matcher: Matcher,
}

pub(super) struct SymbolMatch {
    hit: SymbolSearchHit,
    name_len: usize,
}

impl SymbolDeltaMatcher {
    pub fn new(sources: impl IntoIterator<Item = SourceSymbols>) -> Self {
        let mut shared_sources = Vec::new();
        let mut items = Vec::new();
        for source in sources {
            let source_index = shared_sources.len();
            shared_sources.push(source.source);
            items.extend(
                source
                    .symbols
                    .into_iter()
                    .map(|symbol| make_candidate(source_index, symbol)),
            );
        }
        Self {
            sources: shared_sources,
            items,
            matcher: Matcher::new(Config::DEFAULT),
        }
    }

    pub fn candidates(
        &mut self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
        excluded: &BTreeSet<PathBuf>,
    ) -> Result<Vec<SymbolMatch>, SymbolIndexError> {
        check_cancelled(cancellation)?;
        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let mut matches = Vec::new();
        for (index, (candidate, name)) in self.items.iter().enumerate() {
            check_cancelled(cancellation)?;
            if excluded.contains(&self.sources[candidate.source].relative_path) {
                continue;
            }
            if let Some(score) = pattern.score(name.slice(..), &mut self.matcher) {
                matches.push((score, name.len(), index));
            }
        }
        matches.sort_unstable_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.cmp(&right.2))
        });
        matches.truncate(limit);
        Ok(matches
            .into_iter()
            .map(|(score, _, index)| {
                let (candidate, name) = &self.items[index];
                make_match(
                    &self.sources,
                    candidate,
                    name,
                    score,
                    &pattern,
                    &mut self.matcher,
                )
            })
            .collect())
    }
}

pub(super) fn candidate_limit(result_limit: usize) -> usize {
    result_limit.saturating_mul(4).max(result_limit)
}

fn make_match(
    sources: &[IndexedSourceReference],
    candidate: &Candidate,
    name: &Utf32String,
    score: u32,
    pattern: &Pattern,
    matcher: &mut Matcher,
) -> SymbolMatch {
    let mut matched_indices = Vec::new();
    let _ = pattern.indices(name.slice(..), matcher, &mut matched_indices);
    matched_indices.sort_unstable();
    matched_indices.dedup();
    let original = candidate
        .original_name
        .as_deref()
        .map(str::to_owned)
        .unwrap_or_else(|| name.to_string());
    SymbolMatch {
        name_len: name.len(),
        hit: SymbolSearchHit {
            symbol: SymbolMatcher::materialize(sources, candidate, original),
            score,
            matched_indices,
        },
    }
}

pub(super) fn rank_candidates(
    mut candidates: Vec<SymbolMatch>,
    query: &str,
    result_limit: usize,
) -> Vec<SymbolSearchHit> {
    // A complete matcher injects files in manifest order. Reproduce that tie order when
    // merging the base and delta before applying the existing oversampling and name boosts.
    candidates.sort_by(|left, right| {
        right
            .hit
            .score
            .cmp(&left.hit.score)
            .then(left.name_len.cmp(&right.name_len))
            .then(
                left.hit
                    .symbol
                    .reference
                    .relative_path
                    .cmp(&right.hit.symbol.reference.relative_path),
            )
            .then(
                left.hit
                    .symbol
                    .reference
                    .ordinal
                    .cmp(&right.hit.symbol.reference.ordinal),
            )
    });
    candidates.truncate(candidate_limit(result_limit));
    let query_lower = query.to_lowercase();
    let mut hits: Vec<_> = candidates
        .into_iter()
        .map(|mut candidate| {
            let name_lower = candidate.hit.symbol.name.to_lowercase();
            let boost = if !query_lower.is_empty() && name_lower == query_lower {
                EXACT_MATCH_BOOST
            } else if !query_lower.is_empty() && name_lower.starts_with(&query_lower) {
                PREFIX_MATCH_BOOST
            } else {
                0
            };
            candidate.hit.score = candidate.hit.score.saturating_add(boost);
            candidate.hit
        })
        .collect();
    sort_hits(&mut hits);
    hits.truncate(result_limit);
    hits
}
