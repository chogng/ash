use std::sync::Arc;

use ash_async_utils::CancellationToken;
use nucleo::Config;
use nucleo::Matcher;
use nucleo::Nucleo;
use nucleo::Utf32String;
use nucleo::pattern::CaseMatching;
use nucleo::pattern::Normalization;

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
    name: Box<str>,
    kind: SymbolKind,
    container_name: Option<Box<str>>,
    declaration_range: SymbolRange,
    selection_range: SymbolRange,
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
                let candidate = Candidate {
                    source: source_index,
                    ordinal: symbol.ordinal,
                    name: symbol.name.into_boxed_str(),
                    kind: symbol.kind,
                    container_name: symbol.container_name.map(String::into_boxed_str),
                    declaration_range: symbol.declaration_range,
                    selection_range: symbol.selection_range,
                };
                injector.push(candidate, |candidate, columns| {
                    columns[0] = Utf32String::from(candidate.name.as_ref());
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
        let query_lower = query.to_lowercase();
        let candidate_limit = result_limit.saturating_mul(4).max(result_limit);
        let sources = &self.sources;
        let mut hits = snapshot
            .matches()
            .iter()
            .take(candidate_limit)
            .filter_map(|matched| {
                let item = snapshot.get_item(matched.idx)?;
                let mut matched_indices = Vec::new();
                let _ = pattern.indices(
                    item.matcher_columns[0].slice(..),
                    &mut self.indices_matcher,
                    &mut matched_indices,
                );
                matched_indices.sort_unstable();
                matched_indices.dedup();
                let name_lower = item.data.name.to_lowercase();
                let boost = if !query_lower.is_empty() && name_lower == query_lower {
                    EXACT_MATCH_BOOST
                } else if !query_lower.is_empty() && name_lower.starts_with(&query_lower) {
                    PREFIX_MATCH_BOOST
                } else {
                    0
                };
                Some(SymbolSearchHit {
                    symbol: Self::materialize(sources, item.data),
                    score: matched.score.saturating_add(boost),
                    matched_indices,
                })
            })
            .collect::<Vec<_>>();
        sort_hits(&mut hits);
        hits.truncate(result_limit);
        Ok(hits)
    }

    fn materialize(sources: &[IndexedSourceReference], candidate: &Candidate) -> IndexedSymbol {
        let source = &sources[candidate.source];
        IndexedSymbol {
            reference: SymbolReference {
                root_id: source.root_id.clone(),
                relative_path: source.relative_path.clone(),
                source_revision: source.source_revision.clone(),
                language: source.language.clone(),
                source_bytes: source.source_bytes,
                ordinal: candidate.ordinal,
                declaration_range: candidate.declaration_range.clone(),
                selection_range: candidate.selection_range.clone(),
            },
            name: candidate.name.to_string(),
            kind: candidate.kind,
            container_name: candidate.container_name.as_deref().map(str::to_owned),
        }
    }
}

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
