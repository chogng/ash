//! Shared bounded Nucleo ranking, compiled into the disk service and the indexed engine.

use nucleo_matcher::Config;
use nucleo_matcher::Matcher;
use nucleo_matcher::Utf32Str;
use nucleo_matcher::Utf32String;
use nucleo_matcher::pattern::CaseMatching;
use nucleo_matcher::pattern::Normalization;
use nucleo_matcher::pattern::Pattern;
use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::Path;
use std::path::PathBuf;

/// One fuzzy file-path match relative to the searched directory root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathMatch {
    /// Relevance score produced by Nucleo.
    pub score: u32,
    /// UTF-8 path relative to the search root.
    pub path: PathBuf,
    /// Sorted, deduplicated character indices used to highlight the fuzzy match.
    pub indices: Vec<u32>,
}

/// A complete ranking with bounded paths and counts over all admitted candidates.
pub struct Ranking {
    pub matches: Vec<PathMatch>,
    pub total_match_count: usize,
    pub scanned_file_count: usize,
}

/// Selects by score and path before truncating, independently of discovery order.
pub(crate) struct TopMatches {
    limit: usize,
    matches: BinaryHeap<Reverse<(u32, Reverse<PathBuf>)>>,
}

impl TopMatches {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            matches: BinaryHeap::new(),
        }
    }

    pub(crate) fn push(&mut self, score: u32, path: &Path) {
        if self.matches.len() == self.limit
            && let Some(Reverse((lowest_score, Reverse(worst_path)))) = self.matches.peek()
            && (score < *lowest_score || (score == *lowest_score && path >= worst_path.as_path()))
        {
            return;
        }
        self.matches
            .push(Reverse((score, Reverse(path.to_path_buf()))));
        if self.matches.len() > self.limit {
            self.matches.pop();
        }
    }

    pub(crate) fn into_sorted(self) -> Vec<(u32, PathBuf)> {
        let mut matches = self
            .matches
            .into_iter()
            .map(|Reverse((score, Reverse(path)))| (score, path))
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        matches
    }
}

/// Callers validate input and retain their authorization while ranking runs.
/// `check` supplies cancellation and the deadline without coupling this module to a host.
pub fn rank<P: AsRef<Path>, E>(
    paths: impl IntoIterator<Item = Result<P, E>>,
    query: &str,
    max_results: usize,
    mut check: impl FnMut() -> Result<(), E>,
) -> Result<Ranking, E> {
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    check()?;
    let mut matches = TopMatches::new(max_results);
    let mut characters = Vec::new();
    let mut total_match_count = 0;
    let mut scanned_file_count = 0;
    for path in paths {
        check()?;
        let path = path?;
        let path = path.as_ref();
        scanned_file_count += 1;
        let Some(path_text) = path.to_str() else {
            continue;
        };
        let path_text = if std::path::MAIN_SEPARATOR == '/' {
            Cow::Borrowed(path_text)
        } else {
            Cow::Owned(path_text.replace(std::path::MAIN_SEPARATOR, "/"))
        };
        let text = Utf32Str::new(&path_text, &mut characters);
        let Some(score) = pattern.score(text, &mut matcher) else {
            continue;
        };
        total_match_count += 1;
        // Retain only the best paths; highlighting is needed only for the bounded result set.
        matches.push(score, Path::new(path_text.as_ref()));
    }
    let matches = matches
        .into_sorted()
        .into_iter()
        .map(|(score, path)| {
            check()?;
            let text = Utf32String::from(path.to_str().expect("validated UTF-8 path"));
            let mut indices = Vec::new();
            pattern.indices(text.slice(..), &mut matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            Ok(PathMatch {
                score,
                path,
                indices,
            })
        })
        .collect::<Result<Vec<_>, E>>()?;
    check()?;
    Ok(Ranking {
        matches,
        total_match_count,
        scanned_file_count,
    })
}
