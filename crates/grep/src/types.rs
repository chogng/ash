use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use std::fmt;
use std::path::PathBuf;

/// Ranked file names from the directory registration, with counts before truncation.
#[derive(Debug)]
pub struct FuzzyFileMatches {
    pub matches: Vec<FuzzyFileMatch>,
    pub total_match_count: usize,
    pub scanned_file_count: usize,
}

/// One root-relative file name with its relevance score and character highlights.
#[derive(Debug)]
pub struct FuzzyFileMatch {
    pub score: u32,
    pub path: PathBuf,
    pub indices: Vec<u32>,
}

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
/// For tgrep directory queries, indexed includes filter the ordinary, non-hidden corpus;
/// current includes may explicitly admit ignored files. This also holds before index readiness.
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
    pub index_stats: Option<IndexStats>,
}

/// Indexed file-selection diagnostics, including acknowledged writes and excluding later content batches.
/// Scans have no index statistics. The query plan is an engine diagnostic, not a stable grammar.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexStats {
    pub query_plan: String,
    /// Candidates selected by the trigram plan, before scope and file filters.
    pub raw_candidates: usize,
    /// Candidates remaining after scope, visibility and file filters.
    pub candidates: usize,
    pub total_files: usize,
}

/// Current editor text replacing the corresponding file during one search only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentContent {
    pub path: PathBuf,
    pub text: String,
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
            tgrep::Error::Failed(message) | tgrep::Error::NotReady(message) => {
                Self::Failed(message)
            }
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
    pub index_stats: Option<IndexStats>,
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
