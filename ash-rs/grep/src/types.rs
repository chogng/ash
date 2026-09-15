use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use std::fmt;
use std::path::PathBuf;

/// Selects the installed engine at application composition time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Backend {
    Ripgrep,
    Tgrep,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pattern {
    Literal,
    Regex,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaseSensitivity {
    Smart,
    Sensitive,
    Insensitive,
}

/// Indexed queries include observed writes but may lag external filesystem changes.
/// Current queries read eligible files from disk and bypass cached index contents.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Freshness {
    Indexed,
    Current,
}

/// Search intent within an already-authorized directory. Paths are directory-relative;
/// include/exclude patterns use glob syntax and never accept engine command-line arguments.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Query {
    pub query: String,
    pub pattern: Pattern,
    pub case_sensitivity: CaseSensitivity,
    pub scope: PathBuf,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: usize,
    pub freshness: Freshness,
}

/// UTF-8 byte offsets into the complete matching line, before consumer formatting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Match {
    pub path: PathBuf,
    pub line_number: usize,
    pub content: String,
    pub ranges: Vec<MatchRange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchResult {
    pub matches: Vec<Match>,
    pub limit_hit: bool,
    pub freshness: Freshness,
}

/// Consumer-facing search capability. Implementations own engine execution and honor
/// scope, limits, cancellation and freshness; callers own authorization and presentation.
pub trait Search: Send + Sync {
    fn search(
        &self,
        dir: &Dir,
        query: &Query,
        cancellation: &CancellationToken,
    ) -> Result<SearchResult, Error>;
}

/// Index readiness describes corpus coverage, never a filesystem freshness guarantee.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IndexStatus {
    pub enabled: bool,
    pub active: bool,
    pub indexing: bool,
    pub ready: bool,
    pub indexed_file_count: usize,
    pub watcher_active: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidInput(String),
    Cancelled(String),
    Failed(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Cancelled(message) | Self::Failed(message) => {
                f.write_str(message)
            }
        }
    }
}
impl std::error::Error for Error {}
impl From<tgrep::Error> for Error {
    fn from(error: tgrep::Error) -> Self {
        match error {
            tgrep::Error::Cancelled(reason) => Self::Cancelled(reason),
            tgrep::Error::Failed(message) => Self::Failed(message),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// Opaque caller identity used only to isolate paged jobs.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Owner(u64);
impl Owner {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Page {
    pub matches: Vec<Match>,
    pub next_match: usize,
    pub completed: bool,
    pub limit_hit: bool,
    pub error: Option<String>,
    pub freshness: Option<Freshness>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobError {
    InvalidInput,
    NotFound,
    NotOwner,
    Busy,
    Unavailable,
}
impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "grep job: {self:?}")
    }
}
impl std::error::Error for JobError {}
