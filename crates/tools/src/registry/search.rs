use super::RegisteredTool;
use crate::ToolExposure;
use crate::ToolInvocationKind;
use crate::ToolName;
use crate::ToolSearchError;
use bm25::Document;
use bm25::Language;
use bm25::SearchEngine;
use bm25::SearchEngineBuilder;
use regex::Regex;
use serde_json::Value;
use std::sync::Arc;

pub const TOOL_SEARCH_DEFAULT_LIMIT: usize = 8;
pub(super) const TOOL_SEARCH_MAX_LIMIT: usize = 32;
const TOOL_SEARCH_MAX_QUERY_BYTES: usize = 1_024;

/// Bounded number of deferred definitions returned by one tool search operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolSearchLimit(usize);

impl ToolSearchLimit {
    pub fn new(value: usize) -> Result<Self, ToolSearchError> {
        if value == 0 || value > TOOL_SEARCH_MAX_LIMIT {
            return Err(ToolSearchError::InvalidLimit {
                actual: value,
                maximum: TOOL_SEARCH_MAX_LIMIT,
            });
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> usize {
        self.0
    }
}

impl Default for ToolSearchLimit {
    fn default() -> Self {
        Self(TOOL_SEARCH_DEFAULT_LIMIT)
    }
}

/// Query interpretation selected by the caller of the unified tool-search entry point.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ToolSearchQuerySyntax {
    /// Rank natural-language terms with exact-name matching and BM25.
    #[default]
    NaturalLanguage,
    /// Match a bounded linear-time regular expression against complete search documents.
    Regex,
}

/// Validated lookup scoped to one frozen registry snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSearchQuery {
    text: String,
    limit: ToolSearchLimit,
    syntax: ToolSearchQuerySyntax,
}

impl ToolSearchQuery {
    pub fn new(text: impl Into<String>, limit: ToolSearchLimit) -> Result<Self, ToolSearchError> {
        Self::with_syntax(text, limit, ToolSearchQuerySyntax::NaturalLanguage)
    }

    pub fn regex(
        pattern: impl Into<String>,
        limit: ToolSearchLimit,
    ) -> Result<Self, ToolSearchError> {
        Self::with_syntax(pattern, limit, ToolSearchQuerySyntax::Regex)
    }

    fn with_syntax(
        text: impl Into<String>,
        limit: ToolSearchLimit,
        syntax: ToolSearchQuerySyntax,
    ) -> Result<Self, ToolSearchError> {
        let text = text.into();
        let text = text.trim();
        if text.is_empty() {
            return Err(ToolSearchError::EmptyQuery);
        }
        if text.len() > TOOL_SEARCH_MAX_QUERY_BYTES {
            return Err(ToolSearchError::QueryTooLarge {
                actual: text.len(),
                maximum: TOOL_SEARCH_MAX_QUERY_BYTES,
            });
        }
        if syntax == ToolSearchQuerySyntax::Regex {
            Regex::new(text).map_err(|error| ToolSearchError::InvalidRegex(error.to_string()))?;
        }
        Ok(Self {
            text: text.to_owned(),
            limit,
            syntax,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn limit(&self) -> ToolSearchLimit {
        self.limit
    }

    pub const fn syntax(&self) -> ToolSearchQuerySyntax {
        self.syntax
    }
}

#[derive(Clone)]
pub(super) struct SearchIndex {
    pub(super) documents: Vec<ToolSearchDocument>,
    engine: Arc<SearchEngine<usize>>,
}

impl std::fmt::Debug for SearchIndex {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearchIndex")
            .field("documents", &self.documents)
            .finish_non_exhaustive()
    }
}

impl SearchIndex {
    pub(super) fn new(entries: &[RegisteredTool]) -> Self {
        let documents = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.exposure == ToolExposure::Deferred)
            .map(|(entry_index, entry)| ToolSearchDocument::new(entry_index, entry))
            .collect::<Vec<_>>();
        let bm25_documents: Vec<Document<usize>> = documents
            .iter()
            .map(|document| Document::new(document.entry_index, document.text.clone()))
            .collect();
        let engine =
            SearchEngineBuilder::<usize>::with_documents(Language::English, bm25_documents).build();
        Self {
            documents,
            engine: Arc::new(engine),
        }
    }

    pub(super) fn search(
        &self,
        entries: &[RegisteredTool],
        query: &ToolSearchQuery,
    ) -> Vec<(usize, u64)> {
        self.search_with_limit(entries, query, query.limit().get())
    }

    pub(super) fn search_with_limit(
        &self,
        entries: &[RegisteredTool],
        query: &ToolSearchQuery,
        limit: usize,
    ) -> Vec<(usize, u64)> {
        let mut ranked = match query.syntax() {
            ToolSearchQuerySyntax::NaturalLanguage => {
                self.search_bm25(entries, query.text(), limit)
            }
            ToolSearchQuerySyntax::Regex => self.search_regex(entries, query.text()),
        };
        ranked.sort_by(|(left_index, left_score), (right_index, right_score)| {
            right_score.cmp(left_score).then_with(|| {
                entries[*left_index]
                    .definition
                    .name()
                    .cmp(entries[*right_index].definition.name())
            })
        });
        ranked.truncate(limit);
        ranked
    }

    fn search_bm25(
        &self,
        entries: &[RegisteredTool],
        query: &str,
        limit: usize,
    ) -> Vec<(usize, u64)> {
        let query_text = query.to_lowercase();
        let mut ranked = self
            .engine
            .search(query, limit)
            .into_iter()
            .enumerate()
            .map(|(rank, result)| {
                let entry_index = result.document.id;
                let name = entries[entry_index]
                    .definition
                    .name()
                    .as_str()
                    .to_lowercase();
                let mut score = reciprocal_rank_score(rank);
                if name == query_text {
                    score += 1_000_000;
                } else if name.contains(&query_text) {
                    score += 100_000;
                }
                (entry_index, score)
            })
            .collect::<Vec<_>>();
        for document in &self.documents {
            let name = entries[document.entry_index]
                .definition
                .name()
                .as_str()
                .to_lowercase();
            if name == query_text || name.contains(&query_text) {
                let score = if name == query_text {
                    1_000_000
                } else {
                    100_000
                };
                if let Some((_, existing)) = ranked
                    .iter_mut()
                    .find(|(entry_index, _)| *entry_index == document.entry_index)
                {
                    *existing += score;
                } else {
                    ranked.push((document.entry_index, score));
                }
            }
        }
        ranked
    }

    fn search_regex(&self, entries: &[RegisteredTool], pattern: &str) -> Vec<(usize, u64)> {
        let regex = Regex::new(pattern).expect("ToolSearchQuery validates regex syntax");
        self.documents
            .iter()
            .filter(|document| regex.is_match(&document.text))
            .map(|document| {
                let name = entries[document.entry_index].definition.name().as_str();
                let score = if regex.is_match(name) {
                    1_000_000
                } else {
                    100_000
                };
                (document.entry_index, score)
            })
            .collect()
    }
}

/// Bounded text projected from one deferred tool for an optional semantic retriever.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSearchDocument {
    entry_index: usize,
    name: ToolName,
    text: String,
}

impl ToolSearchDocument {
    fn new(entry_index: usize, entry: &RegisteredTool) -> Self {
        let mut text = String::new();
        add_search_text(&mut text, entry.definition.name().as_str());
        add_search_text(&mut text, entry.definition.description());
        add_search_text(&mut text, entry.search.text());
        if let ToolInvocationKind::Function { input_schema } = entry.definition.invocation() {
            collect_schema_text(input_schema.as_value(), &mut text);
        }
        Self {
            entry_index,
            name: entry.definition.name().clone(),
            text,
        }
    }

    pub fn name(&self) -> &ToolName {
        &self.name
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

pub(super) fn reciprocal_rank_score(rank: usize) -> u64 {
    1_000_000 / (60 + rank as u64)
}

fn add_search_text(text: &mut String, value: &str) {
    if !text.is_empty() {
        text.push(' ');
    }
    text.push_str(value);
}

fn collect_schema_text(value: &Value, text: &mut String) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_schema_text(value, text);
            }
        }
        Value::Object(object) => {
            if let Some(Value::Object(properties)) = object.get("properties") {
                for (name, schema) in properties {
                    add_search_text(text, name);
                    collect_schema_text(schema, text);
                }
            }
            if let Some(Value::String(description)) = object.get("description") {
                add_search_text(text, description);
            }
            for (name, value) in object {
                if name != "properties" && name != "description" {
                    collect_schema_text(value, text);
                }
            }
        }
        Value::Bool(_) | Value::Null | Value::Number(_) | Value::String(_) => {}
    }
}
