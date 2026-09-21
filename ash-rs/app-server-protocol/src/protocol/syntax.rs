use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Grammar supported by the authoritative syntax-analysis service.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxLanguageDto {
    Javascript,
    Javascriptreact,
    Json,
    Jsonc,
    Rust,
    Shell,
    Typescript,
    Typescriptreact,
}

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

/// Immutable document snapshot submitted for bounded syntax analysis.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxAnalyzeParams {
    pub language: SyntaxLanguageDto,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 4_194_304))]
    pub text: String,
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

/// Exact document and editor selections submitted for bounded structural-scope lookup.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSelectionRangesParams {
    pub language: SyntaxLanguageDto,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 4_194_304))]
    pub text: String,
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
