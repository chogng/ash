use std::sync::Arc;

use ash_async_utils::CancellationToken;
use nucleo::Config;
use nucleo::Matcher;
use nucleo::Nucleo;
use nucleo::Utf32String;
use nucleo::pattern::CaseMatching;
use nucleo::pattern::Normalization;

use crate::IndexedSymbol;
use crate::SymbolIndexError;
use crate::SymbolSearchHit;

const MATCH_TICK_MILLIS: u64 = 10;
const EXACT_MATCH_BOOST: u32 = 1_000_000;
const PREFIX_MATCH_BOOST: u32 = 100_000;

pub(crate) struct SymbolMatcher {
    nucleo: Nucleo<Arc<IndexedSymbol>>,
    indices_matcher: Matcher,
}

impl SymbolMatcher {
    pub fn new(symbols: Vec<IndexedSymbol>, worker_threads: usize) -> Self {
        let mut nucleo = Nucleo::new(Config::DEFAULT, Arc::new(|| {}), Some(worker_threads), 1);
        let injector = nucleo.injector();
        for symbol in symbols {
            let name = symbol.name.clone();
            injector.push(Arc::new(symbol), move |_, columns| {
                columns[0] = Utf32String::from(name.as_str());
            });
        }
        while nucleo.tick(MATCH_TICK_MILLIS).running {}
        Self {
            nucleo,
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
                    symbol: item.data.as_ref().clone(),
                    score: matched.score.saturating_add(boost),
                    matched_indices,
                })
            })
            .collect::<Vec<_>>();
        sort_hits(&mut hits);
        hits.truncate(result_limit);
        Ok(hits)
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
