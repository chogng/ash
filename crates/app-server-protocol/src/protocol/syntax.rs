use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

include!("syntax_languages.generated.rs");

/// One zero-based UTF-16 position, matching the editor text-model coordinate system.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxPositionDto {
    pub line_index: usize,
    pub column_index: usize,
}

/// One ordered, end-exclusive UTF-16 source range.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxRangeDto {
    pub start: SyntaxPositionDto,
    pub end: SyntaxPositionDto,
}

/// Stable highlighting category projected from the Rust syntax engine.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxTokenKindDto {
    Attribute,
    Comment,
    Constant,
    Constructor,
    Embedded,
    Function,
    Keyword,
    Label,
    Module,
    Number,
    Operator,
    Property,
    Punctuation,
    String,
    Type,
    Variable,
}

/// One parser-derived syntax token.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxTokenDto {
    pub range: SyntaxRangeDto,
    pub kind: SyntaxTokenKindDto,
}

/// One parser-derived multi-line folding range.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxFoldingRangeDto {
    pub range: SyntaxRangeDto,
}

/// One parser-derived range used for structural selection expansion.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSelectionRangeDto {
    pub range: SyntaxRangeDto,
}

/// Language-neutral kind for one syntactically declared document symbol.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxSymbolKindDto {
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

/// One parser-derived declaration in a document snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSymbolDto {
    pub name: String,
    pub kind: SyntaxSymbolKindDto,
    pub range: SyntaxRangeDto,
    pub selection_range: SyntaxRangeDto,
}

/// Recoverable parser-diagnostic category.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxDiagnosticKindDto {
    Error,
    Missing,
}

/// One parser diagnostic projected for editor presentation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxDiagnosticDto {
    pub range: SyntaxRangeDto,
    pub kind: SyntaxDiagnosticKindDto,
}

/// Establishes one parser document from the editor's current text.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxOpenParams {
    pub document_id: String,
    pub language: SyntaxLanguageDto,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 4_194_304))]
    pub text: String,
}

/// One UTF-16 replacement against the last acknowledged parser revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxEditDto {
    pub start_offset: usize,
    pub end_offset: usize,
    #[schemars(length(max = 4_194_304))]
    pub text: String,
}

/// Advances one parser document without resending its full text.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxUpdateParams {
    pub document_id: String,
    #[ts(type = "number")]
    pub previous_revision: u64,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 1_024))]
    pub edits: Vec<SyntaxEditDto>,
}

/// Requests parser facts from an already synchronized revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxAnalyzeParams {
    pub document_id: String,
    #[ts(type = "number")]
    pub revision: u64,
}

/// Parser-derived facts for exactly one submitted editor revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxAnalyzeResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub has_errors: bool,
    pub tokens: Vec<SyntaxTokenDto>,
    pub folding_ranges: Vec<SyntaxFoldingRangeDto>,
    pub symbols: Vec<SyntaxSymbolDto>,
    pub diagnostics: Vec<SyntaxDiagnosticDto>,
}

/// Editor selections against an already synchronized parser revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSelectionRangesParams {
    pub document_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 1_024))]
    pub ranges: Vec<SyntaxRangeDto>,
}

/// Deduplicated parser scopes enclosing the submitted selections for one exact revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSelectionRangesResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub ranges: Vec<SyntaxSelectionRangeDto>,
}

/// Releases the parser state owned by one editor model on this connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCloseParams {
    pub document_id: String,
}

/// Work performed against the existing shared tree; never reparses a renderer snapshot.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxQueryKindDto {
    Highlight,
    Facts,
    Preview,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxLineRangeDto {
    pub start_line_index: usize,
    pub end_line_index: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxQueryParams {
    pub document_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub kind: SyntaxQueryKindDto,
    /// Last facts revision actually accepted by this consumer; None requests a full result.
    #[ts(type = "number | null")]
    pub facts_revision: Option<u64>,
    pub facts_tab_size: Option<usize>,
    #[schemars(length(max = 1_024))]
    pub ranges: Vec<SyntaxLineRangeDto>,
    pub tab_size: usize,
    pub line_index: Option<usize>,
    #[schemars(length(max = 10_000))]
    pub lines: Vec<String>,
}

/// Cancels only the operation belonging to the sending renderer connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCancelParams {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCaptureDto {
    /// Embedded editor language; omitted for captures belonging to the document language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub language_id: Option<String>,
    pub start: usize,
    pub end: usize,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxRowDto {
    pub row: usize,
    pub tokens: Vec<SyntaxCaptureDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxBracketDto {
    pub range: SyntaxRangeDto,
    pub opening: SyntaxRangeDto,
    pub closing: Option<SyntaxRangeDto>,
    pub text: String,
    pub close_text: Option<String>,
    pub level: usize,
    pub equal_level: usize,
    #[ts(type = "number")]
    pub min_indent: i64,
}

/// CPU measurements exclude transport and renderer work; all results use one tree revision.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxQueryResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub rows: Vec<SyntaxRowDto>,
    pub facts: Option<SyntaxFactsDeltaDto>,
    pub brackets: Vec<SyntaxBracketDto>,
    pub parse_ms: f64,
    pub query_ms: f64,
    pub incremental: bool,
}

/// One splice into a flat, source-ordered symbol list. Ranges are [start row,
/// start UTF-16 column, end row, end UTF-16 column]; fixed tuples avoid repeating
/// field names for every coordinate in large initial snapshots.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSymbolsSpliceDto {
    pub start: usize,
    pub delete_count: usize,
    pub items: Vec<(String, SyntaxSymbolKindDto, [usize; 4], [usize; 4])>,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxFoldsSpliceDto {
    pub start: usize,
    pub delete_count: usize,
    pub items: Vec<(usize, usize, Option<String>)>,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxDiagnosticsSpliceDto {
    pub start: usize,
    pub delete_count: usize,
    pub items: Vec<([usize; 4], SyntaxDiagnosticKindDto)>,
}
/// Apply edits in order before the splices. Each edit is [start row, start
/// column, old end row, old end column, new end row, new end column], in UTF-16.
/// A base mismatch returns a full result (baseRevision None, empty prior lists).
/// A cancelled/unobserved response never requires the consumer to advance its base.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxFactsDeltaDto {
    #[ts(type = "number | null")]
    pub base_revision: Option<u64>,
    pub edits: Vec<[usize; 6]>,
    pub symbols: SyntaxSymbolsSpliceDto,
    pub folds: SyntaxFoldsSpliceDto,
    pub diagnostics: SyntaxDiagnosticsSpliceDto,
}
