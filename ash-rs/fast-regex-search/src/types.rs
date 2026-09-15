use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum FastRegexPattern {
    Literal,
    Regex,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum FastRegexCaseSensitivity {
    Smart,
    Sensitive,
    Insensitive,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexQuery {
    pub query: String,
    pub pattern: FastRegexPattern,
    pub case_sensitivity: FastRegexCaseSensitivity,
    #[serde(with = "crate::worker::serde_path")]
    pub scope: PathBuf,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexRange {
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexMatch {
    #[serde(with = "crate::worker::serde_path")]
    pub path: PathBuf,
    pub line_number: usize,
    pub preview: String,
    pub ranges: Vec<FastRegexRange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexSearchResult {
    pub matches: Vec<FastRegexMatch>,
    pub limit_hit: bool,
    pub statistics: FastRegexSearchStatistics,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexSearchStatistics {
    /// Published corpus used for candidate selection. Filesystem events may still be pending.
    pub generation: u64,
    pub indexed_file_count: usize,
    pub candidate_file_count: usize,
    pub scanned_file_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexSearchSnapshot {
    pub generation: u64,
    pub indexed_file_count: usize,
    pub indexed_source_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FastRegexSearchStorage {
    Memory,
    Persistent(PathBuf),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FastRegexSearchLimits {
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_total_source_bytes: usize,
    pub max_query_bytes: usize,
    pub max_results: usize,
}

impl Default for FastRegexSearchLimits {
    fn default() -> Self {
        Self {
            max_files: 250_000,
            max_file_bytes: 16 * 1024 * 1024,
            max_total_source_bytes: 4 * 1024 * 1024 * 1024,
            max_query_bytes: 16 * 1024,
            max_results: 5_000,
        }
    }
}

impl FastRegexSearchLimits {
    pub(crate) fn check_capacity(&self, files: usize, bytes: usize) -> Result<(), FastRegexError> {
        if files > self.max_files {
            return Err(FastRegexError::IndexLimitExceeded("max_files"));
        }
        if bytes > self.max_total_source_bytes {
            return Err(FastRegexError::IndexLimitExceeded("max_total_source_bytes"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum FastRegexUpdateOutcome {
    NoChange,
    Published(FastRegexSearchSnapshot),
    Rebuilt(FastRegexSearchSnapshot),
}

#[derive(Debug)]
pub enum FastRegexError {
    InvalidQuery(&'static str),
    InvalidGlob,
    InvalidLimits,
    IndexLimitExceeded(&'static str),
    CorruptIndex(PathBuf),
    NotReady,
    StaleSource(PathBuf),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    PublishConflict {
        current: Option<u64>,
    },
    PublishedButDurabilityUnknown {
        path: PathBuf,
        source: std::io::Error,
    },
    Cleanup {
        path: PathBuf,
        source: std::io::Error,
    },
    Worker(String),
    Regex(regex::Error),
}

impl fmt::Display for FastRegexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidQuery(message) => formatter.write_str(message),
            Self::InvalidGlob => formatter.write_str("search glob is invalid"),
            Self::InvalidLimits => formatter.write_str("fast regex search limits are invalid"),
            Self::IndexLimitExceeded(limit) => write!(
                formatter,
                "fast regex index exceeds {limit}; the directory cannot be searched completely"
            ),
            Self::CorruptIndex(path) => {
                write!(
                    formatter,
                    "fast regex search index is corrupt: {}",
                    path.display()
                )
            }
            Self::NotReady => formatter.write_str("fast regex search index is not ready"),
            Self::StaleSource(path) => {
                write!(formatter, "indexed source is stale: {}", path.display())
            }
            Self::Io { path, source } => write!(formatter, "{}: {source}", path.display()),
            Self::PublishConflict { current } => {
                write!(
                    formatter,
                    "fast regex publication conflict; current snapshot is {current:?}"
                )
            }
            Self::PublishedButDurabilityUnknown { path, source } => write!(
                formatter,
                "fast regex snapshot was published but durability is unknown at {}: {source}",
                path.display()
            ),
            Self::Cleanup { path, source } => write!(
                formatter,
                "fast regex snapshot was published but stale data cleanup failed at {}: {source}",
                path.display()
            ),
            Self::Worker(message) => write!(formatter, "fast regex worker failed: {message}"),
            Self::Regex(error) => write!(formatter, "regular expression is invalid: {error}"),
        }
    }
}

impl std::error::Error for FastRegexError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. }
            | Self::PublishedButDurabilityUnknown { source, .. }
            | Self::Cleanup { source, .. } => Some(source),
            Self::Regex(error) => Some(error),
            _ => None,
        }
    }
}

impl From<regex::Error> for FastRegexError {
    fn from(error: regex::Error) -> Self {
        Self::Regex(error)
    }
}
