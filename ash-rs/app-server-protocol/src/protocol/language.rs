use crate::JsonSchema;
use crate::TS;
use crate::protocol::environment::SessionDirSelector;
use crate::protocol::fs::FsDeleteMode;
use crate::protocol::fs::FsExistingTargetBehavior;
use crate::protocol::fs::FsMissingTargetBehavior;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

/// Cross-file language operation requested for one source position.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageLocationKindDto {
    Declaration,
    Definition,
    Implementation,
    TypeDefinition,
    References,
}

/// One zero-based UTF-16 editor position.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePositionDto {
    pub line_index: u32,
    pub column_index: u32,
}

/// One ordered, end-exclusive UTF-16 editor range.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRangeDto {
    pub start: LanguagePositionDto,
    pub end: LanguagePositionDto,
}

/// Authoritative source snapshot submitted before one language request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentDto {
    /// directory folder that owns this document in a multi-root directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub language_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    #[schemars(length(max = 10_485_760))]
    pub text: String,
}

/// Updates the language server with one authoritative editor document snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSynchronizeParams {
    pub document: LanguageDocumentDto,
}

/// Releases one directory document from the language-server session.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCloseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// Binds one cancellable language request to a client-generated operation identity.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageOperationParams<P> {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
    pub request: P,
}

/// Requests cancellation of one connection-owned language operation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageCancelParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
}

/// Observable outcome of a language cancellation request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageCancelStatusDto {
    Requested,
    AlreadyRequested,
    Completed,
}

/// Stable terminal classification for one language cancellation command.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageCancelResult {
    pub status: LanguageCancelStatusDto,
}

/// Hover request against exactly one submitted document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHoverParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
}

/// Fresh hover content expressed in editor-native UTF-16 coordinates.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHoverResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub contents: Option<String>,
    pub range: Option<LanguageRangeDto>,
}

/// Why the editor requested completion candidates.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageCompletionTriggerKindDto {
    Invoke,
    TriggerCharacter,
    IncompleteRefresh,
}

/// Completion request against exactly one submitted document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCompletionsParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
    pub trigger_kind: LanguageCompletionTriggerKindDto,
    pub trigger_character: Option<String>,
}

/// Presentation-neutral completion category understood by editor products.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageCompletionItemKindDto {
    Text,
    Method,
    Function,
    Constructor,
    Field,
    Variable,
    Class,
    Interface,
    Module,
    Property,
    Unit,
    Value,
    Enum,
    Keyword,
    Snippet,
    File,
    Folder,
    Reference,
    TypeParameter,
}

/// Whether completion insertion text is literal text or snippet syntax.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageCompletionInsertTextFormatDto {
    PlainText,
    Snippet,
}

/// One bounded completion candidate with one safe primary document edit.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCompletionItemDto {
    pub label: String,
    pub kind: LanguageCompletionItemKindDto,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub preselect: Option<bool>,
    pub commit_characters: Vec<String>,
    pub insert_text_format: LanguageCompletionInsertTextFormatDto,
    pub range: LanguageRangeDto,
    pub insert_text: String,
    pub additional_text_edits: Vec<LanguageTextEditDto>,
    pub command: Option<LanguageCommandDto>,
    #[ts(type = "unknown")]
    pub provider_data: Option<Value>,
}

/// Deferred completion details requested for one exact document snapshot.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageResolveCompletionParams {
    pub document: LanguageDocumentDto,
    #[ts(type = "unknown")]
    pub provider_data: Value,
}

/// Presentation details added by `completionItem/resolve`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCompletionDetailsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub detail: Option<String>,
    pub documentation: Option<String>,
}

/// One language-server command attached to an accepted completion.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageExecuteCommandParams {
    pub document: LanguageDocumentDto,
    pub command: LanguageCommandDto,
}

/// Fresh completion candidates for exactly one source document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCompletionsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub is_incomplete: bool,
    pub can_resolve: bool,
    pub items: Vec<LanguageCompletionItemDto>,
}

/// Pull diagnostics against exactly one submitted document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentDiagnosticsParams {
    pub document: LanguageDocumentDto,
}

/// Whether a pull request replaced diagnostics or confirmed the current report.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageDiagnosticReportKindDto {
    Full,
    Unchanged,
}

/// Fresh pull-diagnostic result for exactly one source document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentDiagnosticsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub kind: LanguageDiagnosticReportKindDto,
    pub diagnostics: Vec<LanguageCodeActionDiagnosticDto>,
}

/// Requests one complete directory diagnostic report for a language-server route.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectoryDiagnosticsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub language_id: String,
}

/// Diagnostics for one directory-relative resource.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectoryDiagnosticSnapshotDto {
    pub path: PathBuf,
    pub diagnostics: Vec<LanguageCodeActionDiagnosticDto>,
}

/// Complete directory diagnostic report from one language server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectoryDiagnosticsResult {
    pub supported: bool,
    pub snapshots: Vec<LanguageDirectoryDiagnosticSnapshotDto>,
}

/// Cross-file request against exactly one submitted document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLocationsParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
    pub kind: LanguageLocationKindDto,
    #[serde(default)]
    pub include_declaration: bool,
}

/// One directory-relative target returned in editor-native UTF-16 coordinates.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLocationDto {
    pub path: PathBuf,
    pub range: LanguageRangeDto,
    pub selection_range: LanguageRangeDto,
}

/// Fresh cross-file targets for exactly one source document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLocationsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub locations: Vec<LanguageLocationDto>,
}

/// Call- or type-hierarchy operation requested by an editor.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageHierarchyKindDto {
    PrepareCall,
    IncomingCalls,
    OutgoingCalls,
    PrepareType,
    Supertypes,
    Subtypes,
}

/// One hierarchy symbol, including opaque server data required for follow-up requests.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHierarchyItemDto {
    pub name: String,
    pub symbol_kind: u32,
    pub detail: Option<String>,
    pub path: PathBuf,
    pub range: LanguageRangeDto,
    pub selection_range: LanguageRangeDto,
    #[ts(type = "unknown")]
    pub data: Option<Value>,
}

/// Hierarchy request against exactly one submitted document revision.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHierarchyParams {
    pub document: LanguageDocumentDto,
    pub kind: LanguageHierarchyKindDto,
    pub position: Option<LanguagePositionDto>,
    pub item: Option<LanguageHierarchyItemDto>,
}

/// One hierarchy result and optional call-site ranges.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHierarchyEntryDto {
    pub item: LanguageHierarchyItemDto,
    pub from_path: Option<PathBuf>,
    pub from_ranges: Vec<LanguageRangeDto>,
}

/// Fresh hierarchy entries for exactly one source document revision.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHierarchyResultDto {
    #[ts(type = "number")]
    pub revision: u64,
    pub entries: Vec<LanguageHierarchyEntryDto>,
}

/// Project-wide symbol search for one language-server family.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectorySymbolsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub language_id: String,
    #[schemars(length(max = 1024))]
    pub query: String,
}

/// One project-wide symbol with an exact directory location.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectorySymbolDto {
    pub name: String,
    pub symbol_kind: u32,
    pub container_name: Option<String>,
    pub path: PathBuf,
    pub range: LanguageRangeDto,
}

/// Bounded project-wide symbol result.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectorySymbolsResult {
    pub symbols: Vec<LanguageDirectorySymbolDto>,
}

/// Prepare-rename request against one exact source snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePrepareRenameParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
}

/// Rename target range and initial input text, or `None` when unavailable.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRenamePreparationDto {
    pub range: LanguageRangeDto,
    pub placeholder: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePrepareRenameResult {
    pub preparation: Option<LanguageRenamePreparationDto>,
}

/// directory rename request against one exact source snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRenameParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
    #[schemars(length(min = 1, max = 1024))]
    pub new_name: String,
}

/// One UTF-16 text replacement.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTextEditDto {
    pub range: LanguageRangeDto,
    pub new_text: String,
}

/// Named editor preferences for one formatting request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageFormattingOptionsDto {
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub trim_trailing_whitespace: Option<bool>,
}

/// Whole-document formatting against one exact editor snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentFormattingParams {
    pub document: LanguageDocumentDto,
    pub options: LanguageFormattingOptionsDto,
}

/// Range formatting against one exact editor snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRangeFormattingParams {
    pub document: LanguageDocumentDto,
    pub range: LanguageRangeDto,
    pub options: LanguageFormattingOptionsDto,
}

/// Validated UTF-16 formatting edits for the submitted snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageFormattingResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub edits: Vec<LanguageTextEditDto>,
}

/// Why the editor requested signature help.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageSignatureHelpTriggerKindDto {
    Invoke,
    TriggerCharacter,
    ContentChange,
}

/// Signature-help request against one exact editor snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSignatureHelpParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
    pub trigger_kind: LanguageSignatureHelpTriggerKindDto,
    pub trigger_character: Option<String>,
}

/// One parameter in a callable signature.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageParameterInformationDto {
    pub label: String,
    pub documentation: Option<String>,
}

/// One callable signature returned by a language server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSignatureInformationDto {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LanguageParameterInformationDto>,
    pub active_parameter: Option<u32>,
}

/// Fresh signature help for the submitted document snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSignatureHelpResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub signatures: Vec<LanguageSignatureInformationDto>,
    pub active_signature: Option<u32>,
}

/// Inlay-hint request against one exact editor snapshot and UTF-16 range.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInlayHintsParams {
    pub document: LanguageDocumentDto,
    pub range: LanguageRangeDto,
}

/// Presentation-neutral inlay-hint category.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageInlayHintKindDto {
    Type,
    Parameter,
    Other,
}

/// One non-mutating inlay hint in editor-native UTF-16 coordinates.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInlayHintDto {
    pub position: LanguagePositionDto,
    pub label: String,
    pub kind: LanguageInlayHintKindDto,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

/// Fresh bounded inlay hints for the submitted snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInlayHintsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub hints: Vec<LanguageInlayHintDto>,
}

/// Linked-editing request against one exact editor snapshot and UTF-16 position.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLinkedEditingRangesParams {
    pub document: LanguageDocumentDto,
    pub position: LanguagePositionDto,
}

/// Fresh linked ranges whose text must remain identical in one editor transaction.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLinkedEditingRangesResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub ranges: Vec<LanguageRangeDto>,
    pub word_pattern: Option<String>,
}

/// Full-document semantic-token request against one exact editor snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSemanticTokensParams {
    pub document: LanguageDocumentDto,
}

/// One semantic token in editor-native UTF-16 coordinates.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSemanticTokenDto {
    pub range: LanguageRangeDto,
    pub token_type: String,
    pub modifiers: Vec<String>,
}

/// Fresh semantic tokens and the opaque server result identity for one source revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSemanticTokensResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub result_id: Option<String>,
    pub tokens: Vec<LanguageSemanticTokenDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentFeaturesParams {
    pub document: LanguageDocumentDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentSymbolDto {
    pub name: String,
    pub detail: Option<String>,
    pub symbol_kind: u32,
    pub range: LanguageRangeDto,
    pub selection_range: LanguageRangeDto,
    pub children: Vec<LanguageDocumentSymbolDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentSymbolsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub symbols: Vec<LanguageDocumentSymbolDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCommandDto {
    pub id: String,
    pub title: String,
    #[ts(type = "Array<unknown>")]
    pub arguments: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeLensDto {
    pub range: LanguageRangeDto,
    pub command: Option<LanguageCommandDto>,
    #[ts(type = "unknown")]
    pub provider_data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeLensesResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub lenses: Vec<LanguageCodeLensDto>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageResolveCodeLensParams {
    pub document: LanguageDocumentDto,
    pub lens: LanguageCodeLensDto,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentLinkDto {
    pub range: LanguageRangeDto,
    pub target: Option<String>,
    pub tooltip: Option<String>,
    #[ts(type = "unknown")]
    pub provider_data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentLinksResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub links: Vec<LanguageDocumentLinkDto>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageResolveDocumentLinkParams {
    pub document: LanguageDocumentDto,
    pub link: LanguageDocumentLinkDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageColorDto {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentColorDto {
    pub range: LanguageRangeDto,
    pub color: LanguageColorDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocumentColorsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub colors: Vec<LanguageDocumentColorDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageColorPresentationsParams {
    pub document: LanguageDocumentDto,
    pub range: LanguageRangeDto,
    pub color: LanguageColorDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageColorPresentationDto {
    pub label: String,
    pub text_edit: Option<LanguageTextEditDto>,
    pub additional_text_edits: Vec<LanguageTextEditDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageColorPresentationsResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub presentations: Vec<LanguageColorPresentationDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageFoldingRangeKindDto {
    Comment,
    Imports,
    Region,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageFoldingRangeDto {
    pub start_line_index: u32,
    pub end_line_index: u32,
    pub kind: Option<LanguageFoldingRangeKindDto>,
    pub collapsed_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageFoldingRangesResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub ranges: Vec<LanguageFoldingRangeDto>,
}

/// Text replacements for one exact directory content baseline.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTextDocumentEditDto {
    pub path: PathBuf,
    pub expected_text: String,
    pub edits: Vec<LanguageTextEditDto>,
}

/// One ordered text or resource operation returned by a language server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(tag = "kind")]
pub enum LanguageDirectoryEditEntryDto {
    TextDocument {
        document: LanguageTextDocumentEditDto,
    },
    Create {
        path: PathBuf,
        existing: FsExistingTargetBehavior,
    },
    Rename {
        source: PathBuf,
        target: PathBuf,
        existing: FsExistingTargetBehavior,
    },
    Delete {
        path: PathBuf,
        missing: FsMissingTargetBehavior,
        mode: FsDeleteMode,
    },
}

/// Ordered directory edit spanning text documents and directory resources.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDirectoryEditDto {
    pub entries: Vec<LanguageDirectoryEditEntryDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageDiagnosticSeverityDto {
    Error,
    Warning,
    Information,
    Hint,
}

/// Diagnostic context submitted with a code-action request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeActionDiagnosticDto {
    pub range: LanguageRangeDto,
    pub severity: LanguageDiagnosticSeverityDto,
    pub message: String,
    #[ts(type = "unknown")]
    pub code: Option<Value>,
    pub source: Option<String>,
}

/// Fresh language-server diagnostics for one exact directory document revision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDiagnosticsNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub path: PathBuf,
    #[ts(type = "number")]
    pub revision: u64,
    pub diagnostics: Vec<LanguageCodeActionDiagnosticDto>,
}

/// Presentation severity retained from an LSP window message.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageServerMessageSeverityDto {
    Error,
    Warning,
    Information,
    Log,
}

/// Origin retained for filtering language-server output.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageServerMessageSourceDto {
    Protocol,
    Stderr,
    Service,
}

/// One language-server log or user-visible message.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerMessageNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub server: String,
    pub severity: LanguageServerMessageSeverityDto,
    pub source: LanguageServerMessageSourceDto,
    pub show: bool,
    pub message: String,
}

/// Current work-done progress state for one server-owned token.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerProgressNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub server: String,
    pub token: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub percentage: Option<u32>,
    pub done: bool,
}

/// Product-visible lifecycle state of one configured language server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LanguageServerStateDto {
    Starting,
    Ready,
    BackingOff {
        attempt: u32,
        #[serde(rename = "retryAfterMillis")]
        #[ts(type = "number")]
        retry_after_millis: u64,
    },
    CrashLoop {
        #[serde(rename = "restartAttempts")]
        restart_attempts: u32,
        message: String,
    },
    Failed {
        message: String,
    },
    Stopped,
}

/// One authoritative language-server lifecycle transition.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerStateNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub server: String,
    pub state: LanguageServerStateDto,
}

/// Code-action request against one exact source snapshot and selection.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeActionsParams {
    pub document: LanguageDocumentDto,
    pub range: LanguageRangeDto,
    pub diagnostics: Vec<LanguageCodeActionDiagnosticDto>,
    pub only: Vec<String>,
}

/// One code action. `provider_data` must be returned unchanged for resolution.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeActionDto {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub disabled_reason: Option<String>,
    pub edit: Option<LanguageDirectoryEditDto>,
    #[ts(type = "unknown")]
    pub provider_data: Value,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCodeActionsResult {
    pub actions: Vec<LanguageCodeActionDto>,
}

/// Resolve request for one action returned by the same language server.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageResolveCodeActionParams {
    pub document: LanguageDocumentDto,
    #[ts(type = "unknown")]
    pub provider_data: Value,
}
