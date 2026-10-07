use crate::JsonSchema;
use crate::TS;
use crate::protocol::language::LanguageDocumentDto;
use crate::protocol::language::LanguageRangeDto;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

/// Lifecycle state of the directory-side declaration projection.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CodebaseSymbolsStateDto {
    Empty,
    Indexing,
    Ready,
    Stale,
    Failed,
}

/// Published counters for the current or most recent usable symbol generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSymbolsStatusResult {
    pub state: CodebaseSymbolsStateDto,
    pub root_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    #[ts(type = "number")]
    pub source_generation: u64,
    pub indexed_source_count: usize,
    pub indexed_symbol_count: usize,
    pub symbol_limit_hit: bool,
}

/// Performs one bounded local fuzzy lookup against directory declarations.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSymbolsSearchParams {
    #[schemars(length(max = 8192))]
    pub query: String,
    #[schemars(range(min = 1, max = 100))]
    pub max_results: usize,
}

/// Language-neutral category of a syntactically declared symbol.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKindDto {
    Constant,
    Enum,
    Field,
    Function,
    Macro,
    Method,
    Module,
    Static,
    Struct,
    Trait,
    Type,
    Variable,
}

/// One revision-verified local symbol match in editor-native UTF-16 coordinates.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSymbolsSearchHitDto {
    pub name: String,
    pub kind: SymbolKindDto,
    pub container_name: Option<String>,
    pub path: PathBuf,
    pub language: String,
    pub source_revision: String,
    pub declaration_range: LanguageRangeDto,
    pub selection_range: LanguageRangeDto,
    pub score: u32,
    /// Zero-based UTF-16 offsets into `name` suitable for Renderer highlighting.
    pub matched_indices: Vec<u32>,
}

/// Bounded verified matches paired with the symbol generation that served them.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSymbolsSearchResult {
    pub status: CodebaseSymbolsStatusResult,
    pub hits: Vec<CodebaseSymbolsSearchHitDto>,
    /// Matches discarded because their exact source revision could no longer be materialized.
    pub discarded_stale_hit_count: usize,
}

/// Publishes the latest immutable editor text for one directory-relative document.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOverlaySynchronizeParams {
    pub document: LanguageDocumentDto,
}

/// Releases one editor document from the ephemeral code-intelligence overlay.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOverlayCloseParams {
    pub path: PathBuf,
}

/// Content-free summary of the current in-memory editor overlay.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOverlayStatusResult {
    #[ts(type = "number")]
    pub generation: u64,
    pub dirty_document_count: usize,
}
