//! Case-insensitive fuzzy matching for small in-process catalogs and UI lists.

use nucleo_matcher::Config;
use nucleo_matcher::Matcher;
use nucleo_matcher::Utf32Str;

/// Reuses matcher scratch space for every candidate in one query.
///
/// Callers own field priority, prefix rules and stable ordering. Scores increase with match
/// quality; indices refer to Unicode scalar positions, as used by the text renderers, rather
/// than byte or grapheme offsets. Accent normalization is disabled to preserve literal search.
pub struct FuzzyMatcher {
    matcher: Matcher,
    query: Vec<char>,
    text: Vec<char>,
}

impl FuzzyMatcher {
    pub fn new(query: &str) -> Self {
        let mut config = Config::DEFAULT;
        config.normalize = false;
        Self {
            matcher: Matcher::new(config),
            query: query
                .chars()
                .map(nucleo_matcher::chars::to_lower_case)
                .collect(),
            text: Vec::new(),
        }
    }

    pub fn score(&mut self, text: &str) -> Option<u16> {
        self.text.clear();
        self.text.extend(text.chars());
        self.matcher.fuzzy_match(
            Utf32Str::Unicode(&self.text),
            Utf32Str::Unicode(&self.query),
        )
    }

    pub fn indices(&mut self, text: &str) -> Vec<usize> {
        if self.query.is_empty() {
            return Vec::new();
        }
        self.text.clear();
        self.text.extend(text.chars());
        let mut indices = Vec::new();
        if self
            .matcher
            .fuzzy_indices(
                Utf32Str::Unicode(&self.text),
                Utf32Str::Unicode(&self.query),
                &mut indices,
            )
            .is_none()
        {
            return Vec::new();
        }
        indices.into_iter().map(|index| index as usize).collect()
    }
}

#[cfg(test)]
#[path = "matcher_tests.rs"]
mod tests;
