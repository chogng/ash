use std::fmt;

use serde::Deserialize;
use serde::Serialize;

/// One bounded search query sent to the selected backend.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WebSearchQuery {
    pub q: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domains: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recency_days: Option<u32>,
}

/// Requested response density independent of any provider token representation.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchResponseLength {
    Short,
    #[default]
    Medium,
    Long,
}

/// Provider-neutral input accepted by a Web Search backend.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WebSearchRequest {
    pub search_query: Vec<WebSearchQuery>,
    #[serde(default)]
    pub response_length: WebSearchResponseLength,
}

impl WebSearchRequest {
    pub(crate) fn validate(&self) -> Result<(), WebSearchError> {
        if self.search_query.is_empty() || self.search_query.len() > 4 {
            return Err(WebSearchError::InvalidRequest(
                "web search requires between 1 and 4 queries".into(),
            ));
        }
        for query in &self.search_query {
            if query.q.trim().is_empty() || query.q.len() > 2_048 {
                return Err(WebSearchError::InvalidRequest(
                    "web search query must be 1-2048 bytes".into(),
                ));
            }
            if query.domains.len() > 20 || query.domains.iter().any(|domain| !valid_domain(domain))
            {
                return Err(WebSearchError::InvalidRequest(
                    "web search domains must be exact lowercase DNS names".into(),
                ));
            }
        }
        Ok(())
    }
}

/// One source returned by the configured Web Search provider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

/// Provider-neutral Web Search output rendered back to the model as JSON.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchResponse {
    pub results: Vec<WebSearchResult>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebSearchError {
    InvalidRequest(String),
    Unavailable(String),
    InvalidResponse(String),
}

impl fmt::Display for WebSearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => {
                write!(formatter, "invalid Web Search request: {message}")
            }
            Self::Unavailable(message) => write!(formatter, "Web Search is unavailable: {message}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid Web Search response: {message}")
            }
        }
    }
}

impl std::error::Error for WebSearchError {}

fn valid_domain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.to_ascii_lowercase()
        && value.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}
