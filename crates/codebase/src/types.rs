use std::fmt;
use std::num::NonZeroUsize;
use std::ops::Range;
use std::path::PathBuf;

use ash_file_access::Dir;

const DEFAULT_MAX_FILES: usize = 50_000;
const DEFAULT_MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SOURCE_BYTES: usize = 512 * 1024 * 1024;
const DEFAULT_TARGET_CHUNK_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 12 * 1024;
const DEFAULT_MAX_CHUNKS_PER_FILE: usize = 2_048;
const DEFAULT_MAX_QUERY_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_RESULTS: usize = 100;

/// Stable, path-derived identity for one canonical index root.
///
/// This is intentionally distinct from directory capability state even though both identities are
/// derived from the same canonical path boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct IndexRootId(String);

impl IndexRootId {
    #[doc(hidden)]
    pub fn from_root(root: &Dir) -> Self {
        Self(root.id().as_str().to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for IndexRootId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

macro_rules! digest_identity {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(pub(crate) String);

        impl $name {
            #[doc(hidden)]
            pub fn new(value: String) -> Self {
                Self(value)
            }

            /// Parses one canonical `sha256:` identity received from a durable or remote boundary.
            pub fn parse(value: impl Into<String>) -> Result<Self, crate::CodebaseError> {
                let value = value.into();
                let digest =
                    value
                        .strip_prefix("sha256:")
                        .ok_or(crate::CodebaseError::InvalidIdentity(
                            "identity must use the sha256 scheme",
                        ))?;
                if digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(crate::CodebaseError::InvalidIdentity(
                        "sha256 identity must contain 64 lowercase hexadecimal digits",
                    ));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

digest_identity!(
    SourceRevision,
    "SHA-256 identity of the complete UTF-8 source file used to build indexed chunks."
);
digest_identity!(
    ChunkContentHash,
    "SHA-256 identity of the exact source bytes covered by one chunk."
);
digest_identity!(
    ChunkKey,
    "Stable identity of a chunk's content and the chunker contract version."
);

/// Source language selected for structural chunking and result projection.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum IndexedLanguage {
    Javascript,
    JavascriptReact,
    Json,
    Jsonc,
    Rust,
    Shell,
    TypeScript,
    TypeScriptReact,
    PlainText,
}

impl IndexedLanguage {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Javascript => "javascript",
            Self::JavascriptReact => "javascriptreact",
            Self::Json => "json",
            Self::Jsonc => "jsonc",
            Self::Rust => "rust",
            Self::Shell => "shell",
            Self::TypeScript => "typescript",
            Self::TypeScriptReact => "typescriptreact",
            Self::PlainText => "plaintext",
        }
    }

    #[doc(hidden)]
    pub fn from_id(value: &str) -> Self {
        match value {
            "javascript" => Self::Javascript,
            "javascriptreact" => Self::JavascriptReact,
            "json" => Self::Json,
            "jsonc" => Self::Jsonc,
            "rust" => Self::Rust,
            "shell" => Self::Shell,
            "typescript" => Self::TypeScript,
            "typescriptreact" => Self::TypeScriptReact,
            _ => Self::PlainText,
        }
    }
}

/// Exact UTF-8 byte and zero-based line coverage of one indexed chunk.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ChunkSpan {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line_exclusive: usize,
}

impl ChunkSpan {
    pub fn byte_range(&self) -> Range<usize> {
        self.start_byte..self.end_byte
    }
}

/// Revision-bound location and stable content identity of one indexed chunk.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ChunkReference {
    pub root_id: IndexRootId,
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub key: ChunkKey,
    pub content_hash: ChunkContentHash,
    pub span: ChunkSpan,
}

/// Revision-bound source excerpt projected from a Directory-owned chunk reference.
///
/// This transport/context identity omits the internal chunk key, but it must originate from an
/// exact [`ChunkReference`] selected and verified inside the directory authority. Remote services
/// do not define new excerpt boundaries.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SourceExcerptReference {
    pub root_id: IndexRootId,
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub content_hash: ChunkContentHash,
    pub span: ChunkSpan,
}

impl From<&ChunkReference> for SourceExcerptReference {
    fn from(reference: &ChunkReference) -> Self {
        Self {
            root_id: reference.root_id.clone(),
            relative_path: reference.relative_path.clone(),
            source_revision: reference.source_revision.clone(),
            content_hash: reference.content_hash.clone(),
            span: reference.span.clone(),
        }
    }
}

/// One lexical codebase result. Higher scores are more relevant.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub reference: ChunkReference,
    pub language: IndexedLanguage,
    pub content: String,
    pub score: f64,
}

/// A search hit reread and verified against the current directory file revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedChunk {
    pub reference: ChunkReference,
    pub language: IndexedLanguage,
    pub content: String,
}

/// A source excerpt reread and verified against the current directory file revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedExcerpt {
    pub reference: SourceExcerptReference,
    pub language: IndexedLanguage,
    pub content: String,
}

/// Revision-bound metadata for one complete source file in a published index generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedSourceReference {
    pub root_id: IndexRootId,
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub language: IndexedLanguage,
    pub source_bytes: usize,
}

/// One published chunk reference paired with the language recorded by the index generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedChunkReference {
    pub reference: ChunkReference,
    pub language: IndexedLanguage,
}

/// Source and chunk identities published together in one atomic index generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseManifest {
    pub snapshot: CodebaseSnapshot,
    pub sources: Vec<IndexedSourceReference>,
    pub chunks: Vec<IndexedChunkReference>,
}

/// One complete source file reread and verified against a published manifest reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedSource {
    pub reference: IndexedSourceReference,
    pub content: String,
}

/// Latest immutable editor snapshot submitted to the directory-owned in-memory overlay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseOverlayDocument {
    pub relative_path: PathBuf,
    pub editor_revision: u64,
    pub language: IndexedLanguage,
    pub content: String,
}

/// One materialized dirty source and its canonical in-memory chunks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedOverlayDocument {
    pub editor_revision: u64,
    pub source: MaterializedSource,
    pub chunks: Vec<MaterializedChunk>,
}

/// Immutable content-bearing snapshot of every dirty document for one overlay generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseOverlaySnapshot {
    pub generation: u64,
    pub documents: Vec<MaterializedOverlayDocument>,
}

/// Resource and result limits applied by one Codebase.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseLimits {
    pub(crate) max_files: usize,
    pub(crate) max_file_bytes: usize,
    pub(crate) max_total_source_bytes: usize,
    pub(crate) target_chunk_bytes: usize,
    pub(crate) max_chunk_bytes: usize,
    pub(crate) max_chunks_per_file: usize,
    pub(crate) max_query_bytes: usize,
    pub(crate) max_results: usize,
}

impl CodebaseLimits {
    pub fn with_max_files(mut self, value: NonZeroUsize) -> Self {
        self.max_files = value.get();
        self
    }

    pub fn with_max_file_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_file_bytes = value.get();
        self
    }

    pub fn with_max_total_source_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_total_source_bytes = value.get();
        self
    }

    pub fn with_target_chunk_bytes(mut self, value: NonZeroUsize) -> Self {
        self.target_chunk_bytes = value.get();
        self
    }

    pub fn with_max_chunk_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_chunk_bytes = value.get();
        self
    }

    pub fn with_max_chunks_per_file(mut self, value: NonZeroUsize) -> Self {
        self.max_chunks_per_file = value.get();
        self
    }

    pub fn with_max_query_bytes(mut self, value: NonZeroUsize) -> Self {
        self.max_query_bytes = value.get();
        self
    }

    pub fn with_max_results(mut self, value: NonZeroUsize) -> Self {
        self.max_results = value.get();
        self
    }
}

impl Default for CodebaseLimits {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_FILES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_total_source_bytes: DEFAULT_MAX_TOTAL_SOURCE_BYTES,
            target_chunk_bytes: DEFAULT_TARGET_CHUNK_BYTES,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
            max_chunks_per_file: DEFAULT_MAX_CHUNKS_PER_FILE,
            max_query_bytes: DEFAULT_MAX_QUERY_BYTES,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

/// Literal lexical query and requested result bound.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseQuery {
    text: String,
    result_limit: NonZeroUsize,
}

impl CodebaseQuery {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            result_limit: NonZeroUsize::new(20).expect("20 is non-zero"),
        }
    }

    pub fn with_result_limit(mut self, result_limit: NonZeroUsize) -> Self {
        self.result_limit = result_limit;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn result_limit(&self) -> NonZeroUsize {
        self.result_limit
    }
}

/// Immutable publication summary for one indexed directory generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseSnapshot {
    pub root_id: IndexRootId,
    pub generation: u64,
    pub indexed_file_count: usize,
    pub indexed_chunk_count: usize,
    pub indexed_source_bytes: usize,
    pub skipped_file_count: usize,
    pub truncated_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
}

/// Observable result of applying filesystem invalidation hints.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RefreshOutcome {
    NoChange,
    Published(CodebaseSnapshot),
    Rebuilt(CodebaseSnapshot),
}
