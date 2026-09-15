//! Product-neutral language request inputs and projected results.

use std::path::PathBuf;

use ash_lsp::lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, CodeAction,
    CodeActionOrCommand, CompletionItem, CompletionItemKind, CompletionResponse,
    CompletionTextEdit, DocumentChangeOperation, DocumentChanges, DocumentDiagnosticReport,
    DocumentDiagnosticReportResult, Documentation, GotoDefinitionResponse, Hover, HoverContents,
    InlayHint, InlayHintKind, InlayHintLabel, InlayHintTooltip, InsertTextFormat, LanguageString,
    LinkedEditingRanges, Location, MarkedString, MarkupContent, OneOf, ParameterLabel, Position,
    PositionEncodingKind, PrepareRenameResponse, Range, ResourceOp, SignatureHelp, SymbolKind,
    TextDocumentEdit, TextEdit, TypeHierarchyItem, Uri, WorkspaceEdit, WorkspaceSymbolResponse,
};
use serde_json::Value;

use crate::document_features::LanguageCommand;
use crate::projection::{byte_offset_for_position, byte_range_for_lsp_range, project_diagnostic};
use crate::{LanguageDiagnostic, LanguageDocumentRevision, LanguageTextRange};

const MAX_COMPLETION_ITEMS: usize = 200;
const MAX_FORMATTING_EDITS: usize = 10_000;
const MAX_FORMATTING_REPLACEMENT_BYTES: usize = 10 * 1024 * 1024;

/// Monotonic identity assigned when a product request crosses the service boundary.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LanguageRequestId(u64);

impl LanguageRequestId {
    /// Creates an identity assigned by a product adapter at its request boundary.
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

/// Request operation used for capability failures and asynchronous error reporting.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum LanguageRequestKind {
    Hover,
    Completion,
    ResolveCompletion,
    ExecuteCommand,
    Declaration,
    Definition,
    Implementation,
    TypeDefinition,
    References,
    PrepareCallHierarchy,
    IncomingCalls,
    OutgoingCalls,
    PrepareTypeHierarchy,
    Supertypes,
    Subtypes,
    WorkspaceSymbols,
    PrepareRename,
    Rename,
    CodeActions,
    ResolveCodeAction,
    DocumentFormatting,
    RangeFormatting,
    SignatureHelp,
    InlayHints,
    LinkedEditingRanges,
    SemanticTokens,
    DocumentSymbols,
    CodeLenses,
    ResolveCodeLens,
    DocumentLinks,
    ResolveDocumentLink,
    DocumentColors,
    ColorPresentations,
    FoldingRanges,
    DocumentDiagnostics,
    WorkspaceDiagnostics,
}

/// UTF-8 position inside one source row of an authoritative editor snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageDocumentPosition {
    pub row: u32,
    pub byte_offset: u32,
}

impl LanguageDocumentPosition {
    pub const fn new(row: u32, byte_offset: u32) -> Self {
        Self { row, byte_offset }
    }
}

/// Fresh hover content bound to the exact document revision that requested it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageHover {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub contents: String,
    pub range: Option<LanguageTextRange>,
}

/// One bounded, presentation-neutral completion candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCompletionItem {
    pub label: String,
    pub kind: LanguageCompletionItemKind,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub preselect: Option<bool>,
    pub commit_characters: Vec<String>,
    pub insert_text_format: LanguageCompletionInsertTextFormat,
    pub edit: Option<LanguageTextEdit>,
    pub additional_text_edits: Vec<LanguageTextEdit>,
    pub command: Option<LanguageCommand>,
    pub provider_data: Value,
}

/// Deferred presentation details returned by `completionItem/resolve`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCompletionDetails {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub detail: Option<String>,
    pub documentation: Option<String>,
}

/// Result of a server-advertised workspace command attached to a completion candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCommandResult {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub value: Value,
}

/// Presentation-neutral completion category understood by editor products.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageCompletionItemKind {
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

/// Whether the editor should interpret completion insertion text as snippet syntax.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageCompletionInsertTextFormat {
    PlainText,
    Snippet,
}

/// Why a completion request was issued by the editor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageCompletionTrigger {
    Invoked,
    TriggerCharacter(String),
    IncompleteRefresh,
}

/// One exact UTF-8 edit that can be safely delegated to an editor document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageTextEdit {
    pub range: LanguageTextRange,
    pub new_text: String,
}

/// Editor-owned formatting preferences forwarded without product presentation concerns.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageFormattingOptions {
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub trim_trailing_whitespace: Option<bool>,
}

/// Fresh, validated formatting edits bound to the exact requesting snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageFormattingEdits {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub edits: Vec<LanguageTextEdit>,
}

/// Why an editor requested callable signature information.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageSignatureHelpTrigger {
    Invoked,
    TriggerCharacter(String),
    ContentChange,
}

/// One parameter label and optional provider documentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageParameterInformation {
    pub label: String,
    pub documentation: Option<String>,
}

/// One callable signature with its provider-selected active parameter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSignatureInformation {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LanguageParameterInformation>,
    pub active_parameter: Option<u32>,
}

/// Fresh signature help bound to the exact requesting editor snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSignatureHelp {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub signatures: Vec<LanguageSignatureInformation>,
    pub active_signature: Option<u32>,
}

/// Presentation-neutral category for one inline reading aid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageInlayHintKind {
    Type,
    Parameter,
    Other,
}

/// One non-mutating inline hint at an exact UTF-8 editor position.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageInlayHint {
    pub position: LanguageDocumentPosition,
    pub label: String,
    pub kind: LanguageInlayHintKind,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

/// Fresh bounded inlay hints for the exact requesting editor snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageInlayHints {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub hints: Vec<LanguageInlayHint>,
}

/// Fresh, validated ranges whose contents are edited as one logical value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageLinkedEditingRanges {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub ranges: Vec<LanguageTextRange>,
    pub word_pattern: Option<String>,
}

/// Fresh completion candidates bound to the exact requesting revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCompletions {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub is_incomplete: bool,
    pub can_resolve: bool,
    pub items: Vec<LanguageCompletionItem>,
}

/// One pull-diagnostic report for the requested document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguagePulledDiagnosticReport {
    Full(Vec<LanguageDiagnostic>),
    Unchanged,
}

/// Result of a pull-diagnostic request bound to the exact editor snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguagePulledDiagnostics {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub report: LanguagePulledDiagnosticReport,
}

/// Encoding retained for a definition target whose text is not owned by this service.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguagePositionEncoding {
    Utf8,
    Utf16,
}

/// Semantic operation that produced one set of cross-file locations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageLocationKind {
    Declaration,
    Definition,
    Implementation,
    TypeDefinition,
    Reference,
}

/// One target position expressed in the negotiated language-server encoding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageLocationPosition {
    pub row: u32,
    pub character: u32,
}

/// One ordered target range expressed in the negotiated language-server encoding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageLocationRange {
    pub start: LanguageLocationPosition,
    pub end: LanguageLocationPosition,
}

/// One filesystem target returned by a cross-file language request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageLocationTarget {
    pub path: PathBuf,
    pub range: LanguageLocationRange,
    pub selection_range: LanguageLocationRange,
    pub encoding: LanguagePositionEncoding,
}

/// Fresh cross-file targets bound to the exact requesting revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageLocations {
    pub request_id: LanguageRequestId,
    pub kind: LanguageLocationKind,
    pub source_path: PathBuf,
    pub source_revision: LanguageDocumentRevision,
    pub targets: Vec<LanguageLocationTarget>,
}

/// Semantic operation that produced one hierarchy result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageHierarchyKind {
    PrepareCall,
    IncomingCalls,
    OutgoingCalls,
    PrepareType,
    Supertypes,
    Subtypes,
}

/// One call- or type-hierarchy symbol with the server-owned data required for follow-up requests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageHierarchyItem {
    pub name: String,
    pub symbol_kind: u32,
    pub detail: Option<String>,
    pub path: PathBuf,
    pub range: LanguageLocationRange,
    pub selection_range: LanguageLocationRange,
    pub encoding: LanguagePositionEncoding,
    pub data: Option<Value>,
}

/// One hierarchy edge. `from_ranges` identifies call sites and is empty for type edges.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageHierarchyEntry {
    pub item: LanguageHierarchyItem,
    pub from_path: Option<PathBuf>,
    pub from_ranges: Vec<LanguageLocationRange>,
}

/// Fresh hierarchy entries bound to the exact source revision that initiated the operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageHierarchyResult {
    pub request_id: LanguageRequestId,
    pub kind: LanguageHierarchyKind,
    pub source_path: PathBuf,
    pub source_revision: LanguageDocumentRevision,
    pub entries: Vec<LanguageHierarchyEntry>,
}

/// One project-wide symbol returned independently of an open editor document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSymbol {
    pub name: String,
    pub symbol_kind: u32,
    pub container_name: Option<String>,
    pub path: PathBuf,
    pub range: LanguageLocationRange,
    pub encoding: LanguagePositionEncoding,
}

/// Bounded project-wide symbol response from one language server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSymbols {
    pub request_id: LanguageRequestId,
    pub query: String,
    pub symbols: Vec<LanguageSymbol>,
}

/// One prepare-rename response projected into the authoritative source snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageRenamePreparation {
    pub request_id: LanguageRequestId,
    pub source_path: PathBuf,
    pub source_revision: LanguageDocumentRevision,
    pub range: Option<LanguageTextRange>,
    pub placeholder: Option<String>,
    pub default_behavior: bool,
}

/// One protocol-encoded text replacement for a workspace resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageWorkspaceTextEdit {
    pub range: LanguageLocationRange,
    pub new_text: String,
}

/// All text replacements for one resource in a language-server workspace edit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageWorkspaceDocumentEdit {
    pub path: PathBuf,
    pub server_version: Option<i32>,
    pub edits: Vec<LanguageWorkspaceTextEdit>,
}

/// Behavior when a workspace-edit create or rename target already exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageExistingTargetBehavior {
    Error,
    Overwrite,
    Ignore,
}

/// Behavior when a workspace-edit delete target does not exist.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageMissingTargetBehavior {
    Error,
    Ignore,
}

/// Scope of one workspace-edit delete operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageDeleteMode {
    FileOrEmptyDirectory,
    Recursive,
}

/// One resource operation in the exact order supplied by the language server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageEditEntry {
    TextDocument(LanguageWorkspaceDocumentEdit),
    Create {
        path: PathBuf,
        existing: LanguageExistingTargetBehavior,
    },
    Rename {
        source: PathBuf,
        target: PathBuf,
        existing: LanguageExistingTargetBehavior,
    },
    Delete {
        path: PathBuf,
        missing: LanguageMissingTargetBehavior,
        mode: LanguageDeleteMode,
    },
}

/// Ordered workspace edit containing text and optional resource operations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageEdit {
    pub encoding: LanguagePositionEncoding,
    pub entries: Vec<LanguageEditEntry>,
}

/// Fresh rename result bound to the source revision that initiated it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageEditResult {
    pub request_id: LanguageRequestId,
    pub source_path: PathBuf,
    pub source_revision: LanguageDocumentRevision,
    pub edit: LanguageEdit,
}

/// One LSP code action with any text edit projected and resolve payload kept opaque.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub disabled_reason: Option<String>,
    pub edit: Option<LanguageEdit>,
    pub provider_data: Value,
}

/// Fresh code actions bound to the source revision that requested them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageCodeActions {
    pub request_id: LanguageRequestId,
    pub source_path: PathBuf,
    pub source_revision: LanguageDocumentRevision,
    pub actions: Vec<LanguageCodeAction>,
}

pub(crate) fn protocol_position(
    text: &str,
    position: LanguageDocumentPosition,
    encoding: &PositionEncodingKind,
) -> Option<Position> {
    let row = usize::try_from(position.row).ok()?;
    let byte_offset = usize::try_from(position.byte_offset).ok()?;
    let line = source_line(text, row)?;
    if byte_offset > line.len() || !line.is_char_boundary(byte_offset) {
        return None;
    }
    let character = if *encoding == PositionEncodingKind::UTF8 {
        byte_offset
    } else if *encoding == PositionEncodingKind::UTF16 {
        line[..byte_offset].encode_utf16().count()
    } else {
        return None;
    };
    Some(Position::new(
        u32::try_from(row).ok()?,
        u32::try_from(character).ok()?,
    ))
}

pub(crate) fn project_hover(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    hover: Option<Hover>,
) -> Option<LanguageHover> {
    let hover = hover?;
    let contents = hover_contents(hover.contents);
    if contents.trim().is_empty() {
        return None;
    }
    let range = hover.range.and_then(|range| {
        byte_range_for_lsp_range(text, range.start, range.end, encoding).map(LanguageTextRange::new)
    });
    Some(LanguageHover {
        request_id,
        path,
        revision,
        contents,
        range,
    })
}

pub(crate) fn project_completions(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    request_position: LanguageDocumentPosition,
    text: &str,
    encoding: &PositionEncodingKind,
    can_resolve: bool,
    response: Option<CompletionResponse>,
) -> LanguageCompletions {
    let (is_incomplete, items) = match response {
        Some(CompletionResponse::Array(items)) => (false, items),
        Some(CompletionResponse::List(list)) => (list.is_incomplete, list.items),
        None => (false, Vec::new()),
    };
    let mut preselect_seen = false;
    let items = items
        .into_iter()
        .take(MAX_COMPLETION_ITEMS)
        .filter_map(|item| project_completion_item(item, request_position, text, encoding))
        .map(|mut item| {
            if item.preselect == Some(true) {
                if preselect_seen {
                    item.preselect = Some(false);
                } else {
                    preselect_seen = true;
                }
            }
            item
        })
        .collect();
    LanguageCompletions {
        request_id,
        path,
        revision,
        is_incomplete,
        can_resolve,
        items,
    }
}

pub(crate) fn project_locations(
    request_id: LanguageRequestId,
    kind: LanguageLocationKind,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    response: Option<GotoDefinitionResponse>,
) -> LanguageLocations {
    let ranges = match response {
        Some(GotoDefinitionResponse::Scalar(location)) => {
            vec![(location.uri, location.range, location.range)]
        }
        Some(GotoDefinitionResponse::Array(locations)) => locations
            .into_iter()
            .map(|location| (location.uri, location.range, location.range))
            .collect(),
        Some(GotoDefinitionResponse::Link(links)) => links
            .into_iter()
            .map(|link| {
                (
                    link.target_uri,
                    link.target_range,
                    link.target_selection_range,
                )
            })
            .collect(),
        None => Vec::new(),
    };
    project_location_ranges(
        request_id,
        kind,
        source_path,
        source_revision,
        encoding,
        ranges,
    )
}

pub(crate) fn project_references(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    response: Option<Vec<Location>>,
) -> LanguageLocations {
    let ranges = response
        .unwrap_or_default()
        .into_iter()
        .map(|location| (location.uri, location.range, location.range))
        .collect();
    project_location_ranges(
        request_id,
        LanguageLocationKind::Reference,
        source_path,
        source_revision,
        encoding,
        ranges,
    )
}

pub(crate) fn project_call_hierarchy_items(
    request_id: LanguageRequestId,
    kind: LanguageHierarchyKind,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    items: Vec<CallHierarchyItem>,
) -> LanguageHierarchyResult {
    project_hierarchy_entries(
        request_id,
        kind,
        source_path,
        source_revision,
        items
            .into_iter()
            .filter_map(|item| {
                project_call_item(item, encoding).map(|item| LanguageHierarchyEntry {
                    item,
                    from_path: None,
                    from_ranges: Vec::new(),
                })
            })
            .collect(),
    )
}

pub(crate) fn project_incoming_calls(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    calls: Vec<CallHierarchyIncomingCall>,
) -> LanguageHierarchyResult {
    project_hierarchy_entries(
        request_id,
        LanguageHierarchyKind::IncomingCalls,
        source_path,
        source_revision,
        calls
            .into_iter()
            .filter_map(|call| {
                project_call_item(call.from, encoding).map(|item| LanguageHierarchyEntry {
                    from_path: Some(item.path.clone()),
                    item,
                    from_ranges: call.from_ranges.into_iter().map(location_range).collect(),
                })
            })
            .collect(),
    )
}

pub(crate) fn project_outgoing_calls(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    from_path: PathBuf,
    calls: Vec<CallHierarchyOutgoingCall>,
) -> LanguageHierarchyResult {
    project_hierarchy_entries(
        request_id,
        LanguageHierarchyKind::OutgoingCalls,
        source_path,
        source_revision,
        calls
            .into_iter()
            .filter_map(|call| {
                project_call_item(call.to, encoding).map(|item| LanguageHierarchyEntry {
                    item,
                    from_path: Some(from_path.clone()),
                    from_ranges: call.from_ranges.into_iter().map(location_range).collect(),
                })
            })
            .collect(),
    )
}

pub(crate) fn project_type_hierarchy_items(
    request_id: LanguageRequestId,
    kind: LanguageHierarchyKind,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    items: Vec<TypeHierarchyItem>,
) -> LanguageHierarchyResult {
    project_hierarchy_entries(
        request_id,
        kind,
        source_path,
        source_revision,
        items
            .into_iter()
            .filter_map(|item| {
                project_type_item(item, encoding).map(|item| LanguageHierarchyEntry {
                    item,
                    from_path: None,
                    from_ranges: Vec::new(),
                })
            })
            .collect(),
    )
}

pub(crate) fn protocol_call_hierarchy_item(
    item: LanguageHierarchyItem,
) -> Option<CallHierarchyItem> {
    Some(CallHierarchyItem {
        name: item.name,
        kind: symbol_kind(item.symbol_kind)?,
        tags: None,
        detail: item.detail,
        uri: file_uri(&item.path)?,
        range: protocol_location_range(item.range),
        selection_range: protocol_location_range(item.selection_range),
        data: item.data,
    })
}

pub(crate) fn protocol_type_hierarchy_item(
    item: LanguageHierarchyItem,
) -> Option<TypeHierarchyItem> {
    Some(TypeHierarchyItem {
        name: item.name,
        kind: symbol_kind(item.symbol_kind)?,
        tags: None,
        detail: item.detail,
        uri: file_uri(&item.path)?,
        range: protocol_location_range(item.range),
        selection_range: protocol_location_range(item.selection_range),
        data: item.data,
    })
}

pub(crate) fn project_workspace_symbols(
    request_id: LanguageRequestId,
    query: String,
    encoding: &PositionEncodingKind,
    response: Option<WorkspaceSymbolResponse>,
) -> LanguageSymbols {
    let symbols = match response {
        Some(WorkspaceSymbolResponse::Flat(symbols)) => symbols
            .into_iter()
            .filter_map(|symbol| {
                project_workspace_symbol(
                    symbol.name,
                    symbol.kind,
                    symbol.container_name,
                    symbol.location.uri,
                    symbol.location.range,
                    encoding,
                )
            })
            .collect(),
        Some(WorkspaceSymbolResponse::Nested(symbols)) => symbols
            .into_iter()
            .filter_map(|symbol| match symbol.location {
                OneOf::Left(location) => project_workspace_symbol(
                    symbol.name,
                    symbol.kind,
                    symbol.container_name,
                    location.uri,
                    location.range,
                    encoding,
                ),
                OneOf::Right(_) => None,
            })
            .collect(),
        None => Vec::new(),
    };
    LanguageSymbols {
        request_id,
        query,
        symbols,
    }
}

pub(crate) fn project_rename_preparation(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    response: Option<PrepareRenameResponse>,
) -> Option<LanguageRenamePreparation> {
    let (range, placeholder, default_behavior) = match response? {
        PrepareRenameResponse::Range(range) => (
            byte_range_for_lsp_range(text, range.start, range.end, encoding)
                .map(LanguageTextRange::new),
            None,
            false,
        ),
        PrepareRenameResponse::RangeWithPlaceholder { range, placeholder } => (
            byte_range_for_lsp_range(text, range.start, range.end, encoding)
                .map(LanguageTextRange::new),
            Some(placeholder),
            false,
        ),
        PrepareRenameResponse::DefaultBehavior { default_behavior } => {
            (None, None, default_behavior)
        }
    };
    if range.is_none() && !default_behavior {
        return None;
    }
    Some(LanguageRenamePreparation {
        request_id,
        source_path,
        source_revision,
        range,
        placeholder,
        default_behavior,
    })
}

pub(crate) fn project_workspace_edit(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    edit: Option<WorkspaceEdit>,
) -> Result<LanguageEditResult, String> {
    let edit = project_text_workspace_edit(encoding, edit.unwrap_or_default())?;
    Ok(LanguageEditResult {
        request_id,
        source_path,
        source_revision,
        edit,
    })
}

pub(crate) fn project_formatting_edits(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    response: Option<Vec<TextEdit>>,
) -> Result<LanguageFormattingEdits, String> {
    let response = response.unwrap_or_default();
    if response.len() > MAX_FORMATTING_EDITS {
        return Err(format!(
            "language server returned more than {MAX_FORMATTING_EDITS} formatting edits"
        ));
    }
    let replacement_bytes = response
        .iter()
        .try_fold(0usize, |total, edit| total.checked_add(edit.new_text.len()))
        .ok_or_else(|| "formatting replacement size overflowed".to_owned())?;
    if replacement_bytes > MAX_FORMATTING_REPLACEMENT_BYTES {
        return Err(format!(
            "language server returned more than {MAX_FORMATTING_REPLACEMENT_BYTES} formatting replacement bytes"
        ));
    }
    let mut edits = response
        .into_iter()
        .map(|edit| {
            let range = byte_range_for_lsp_range(text, edit.range.start, edit.range.end, encoding)
                .ok_or_else(|| "language server returned an invalid formatting range".to_owned())?;
            Ok(LanguageTextEdit {
                range: LanguageTextRange::new(range),
                new_text: edit.new_text,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    edits.sort_by_key(|edit| {
        let range = edit.range.byte_range();
        (range.start, range.end)
    });
    for pair in edits.windows(2) {
        let previous = pair[0].range.byte_range();
        let current = pair[1].range.byte_range();
        if previous.end > current.start || previous.start == current.start {
            return Err("language server returned overlapping formatting edits".into());
        }
    }
    Ok(LanguageFormattingEdits {
        request_id,
        path,
        revision,
        edits,
    })
}

pub(crate) fn project_signature_help(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    response: Option<SignatureHelp>,
) -> Option<LanguageSignatureHelp> {
    let response = response?;
    let signatures = response
        .signatures
        .into_iter()
        .take(100)
        .filter_map(|signature| {
            let label = signature.label;
            if label.trim().is_empty() || label.len() > 16 * 1024 {
                return None;
            }
            let parameters = signature
                .parameters
                .unwrap_or_default()
                .into_iter()
                .take(256)
                .filter_map(|parameter| {
                    let label = match parameter.label {
                        ParameterLabel::Simple(label) => label,
                        ParameterLabel::LabelOffsets([start, end]) => {
                            utf16_label_range(&label, start, end)?
                        }
                    };
                    (!label.trim().is_empty()).then(|| LanguageParameterInformation {
                        label,
                        documentation: parameter
                            .documentation
                            .map(documentation_text)
                            .filter(non_blank),
                    })
                })
                .collect::<Vec<_>>();
            let active_parameter = signature
                .active_parameter
                .or(response.active_parameter)
                .filter(|index| {
                    usize::try_from(*index).is_ok_and(|index| index < parameters.len())
                });
            Some(LanguageSignatureInformation {
                label,
                documentation: signature
                    .documentation
                    .map(documentation_text)
                    .filter(non_blank),
                parameters,
                active_parameter,
            })
        })
        .collect::<Vec<_>>();
    if signatures.is_empty() {
        return None;
    }
    let active_signature = response
        .active_signature
        .filter(|index| usize::try_from(*index).is_ok_and(|index| index < signatures.len()));
    Some(LanguageSignatureHelp {
        request_id,
        path,
        revision,
        signatures,
        active_signature,
    })
}

pub(crate) fn project_inlay_hints(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    response: Option<Vec<InlayHint>>,
) -> LanguageInlayHints {
    let hints = response
        .unwrap_or_default()
        .into_iter()
        .take(5_000)
        .filter_map(|hint| {
            let byte_offset = byte_offset_for_position(text, hint.position, encoding)?;
            let prefix = &text[..byte_offset];
            let row = u32::try_from(prefix.bytes().filter(|byte| *byte == b'\n').count()).ok()?;
            let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
            let position =
                LanguageDocumentPosition::new(row, u32::try_from(byte_offset - line_start).ok()?);
            let label = match hint.label {
                InlayHintLabel::String(label) => label,
                InlayHintLabel::LabelParts(parts) => {
                    parts.into_iter().map(|part| part.value).collect()
                }
            };
            if label.trim().is_empty() || label.len() > 16 * 1024 {
                return None;
            }
            let tooltip = hint
                .tooltip
                .map(|tooltip| match tooltip {
                    InlayHintTooltip::String(value) => value,
                    InlayHintTooltip::MarkupContent(content) => content.value,
                })
                .filter(non_blank);
            Some(LanguageInlayHint {
                position,
                label,
                kind: match hint.kind {
                    Some(kind) if kind == InlayHintKind::TYPE => LanguageInlayHintKind::Type,
                    Some(kind) if kind == InlayHintKind::PARAMETER => {
                        LanguageInlayHintKind::Parameter
                    }
                    _ => LanguageInlayHintKind::Other,
                },
                tooltip,
                padding_left: hint.padding_left.unwrap_or(false),
                padding_right: hint.padding_right.unwrap_or(false),
            })
        })
        .collect();
    LanguageInlayHints {
        request_id,
        path,
        revision,
        hints,
    }
}

pub(crate) fn project_linked_editing_ranges(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    response: Option<LinkedEditingRanges>,
) -> Option<LanguageLinkedEditingRanges> {
    let response = response?;
    if response.ranges.len() < 2 || response.ranges.len() > 256 {
        return None;
    }
    let mut ranges = response
        .ranges
        .into_iter()
        .map(|range| {
            byte_range_for_lsp_range(text, range.start, range.end, encoding)
                .filter(|range| range.start < range.end)
                .map(LanguageTextRange::new)
        })
        .collect::<Option<Vec<_>>>()?;
    ranges.sort_by_key(|range| {
        let range = range.byte_range();
        (range.start, range.end)
    });
    if ranges
        .windows(2)
        .any(|pair| pair[0].byte_range().end > pair[1].byte_range().start)
    {
        return None;
    }
    let expected = &text[ranges[0].byte_range()];
    if ranges
        .iter()
        .skip(1)
        .any(|range| &text[range.byte_range()] != expected)
    {
        return None;
    }
    let word_pattern = response
        .word_pattern
        .filter(|pattern| pattern.len() <= 4_096);
    Some(LanguageLinkedEditingRanges {
        request_id,
        path,
        revision,
        ranges,
        word_pattern,
    })
}

pub(crate) fn project_code_actions(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    can_resolve: bool,
    response: Option<Vec<CodeActionOrCommand>>,
) -> LanguageCodeActions {
    let actions = response
        .unwrap_or_default()
        .into_iter()
        .filter_map(|candidate| match candidate {
            CodeActionOrCommand::Command(_) => None,
            CodeActionOrCommand::CodeAction(action) => {
                project_code_action(encoding, can_resolve, action).ok()
            }
        })
        .collect();
    LanguageCodeActions {
        request_id,
        source_path,
        source_revision,
        actions,
    }
}

pub(crate) fn project_resolved_code_action(
    request_id: LanguageRequestId,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    action: CodeAction,
) -> Result<LanguageCodeActions, String> {
    Ok(LanguageCodeActions {
        request_id,
        source_path,
        source_revision,
        actions: vec![project_code_action(encoding, true, action)?],
    })
}

pub(crate) fn protocol_code_action(data: Value) -> Result<CodeAction, String> {
    serde_json::from_value(data)
        .map_err(|error| format!("invalid code-action resolve payload: {error}"))
}

fn project_code_action(
    encoding: &PositionEncodingKind,
    can_resolve: bool,
    action: CodeAction,
) -> Result<LanguageCodeAction, String> {
    let provider_data = serde_json::to_value(&action).map_err(|error| error.to_string())?;
    let command_only = action.command.is_some();
    let requires_unsupported_resolve = action.edit.is_none() && !command_only && !can_resolve;
    let disabled_reason = action
        .disabled
        .map(|disabled| disabled.reason)
        .or_else(|| {
            command_only
                .then(|| "This action requires an unsupported language-server command".into())
        })
        .or_else(|| {
            requires_unsupported_resolve
                .then(|| "This action requires unsupported language-server resolution".into())
        });
    let edit = action
        .edit
        .map(|edit| project_text_workspace_edit(encoding, edit))
        .transpose()?;
    Ok(LanguageCodeAction {
        title: action.title,
        kind: action.kind.map(|kind| kind.as_str().to_owned()),
        is_preferred: action.is_preferred.unwrap_or(false),
        disabled_reason,
        edit,
        provider_data,
    })
}

fn project_text_workspace_edit(
    encoding: &PositionEncodingKind,
    edit: WorkspaceEdit,
) -> Result<LanguageEdit, String> {
    let has_document_changes = edit.document_changes.is_some();
    let mut entries = if let Some(changes) = edit.document_changes {
        match changes {
            DocumentChanges::Edits(edits) => edits
                .into_iter()
                .map(|edit| project_text_document_edit(edit).map(LanguageEditEntry::TextDocument))
                .collect::<Result<Vec<_>, _>>()?,
            DocumentChanges::Operations(operations) => operations
                .into_iter()
                .map(|operation| match operation {
                    DocumentChangeOperation::Edit(edit) => {
                        project_text_document_edit(edit).map(LanguageEditEntry::TextDocument)
                    }
                    DocumentChangeOperation::Op(ResourceOp::Create(operation)) => {
                        Ok(LanguageEditEntry::Create {
                            path: file_path(&operation.uri).ok_or_else(|| {
                                "workspace create target is not a file URI".to_owned()
                            })?,
                            existing: existing_target_behavior(
                                operation
                                    .options
                                    .as_ref()
                                    .and_then(|options| options.overwrite),
                                operation
                                    .options
                                    .as_ref()
                                    .and_then(|options| options.ignore_if_exists),
                            ),
                        })
                    }
                    DocumentChangeOperation::Op(ResourceOp::Rename(operation)) => {
                        Ok(LanguageEditEntry::Rename {
                            source: file_path(&operation.old_uri).ok_or_else(|| {
                                "workspace rename source is not a file URI".to_owned()
                            })?,
                            target: file_path(&operation.new_uri).ok_or_else(|| {
                                "workspace rename target is not a file URI".to_owned()
                            })?,
                            existing: existing_target_behavior(
                                operation
                                    .options
                                    .as_ref()
                                    .and_then(|options| options.overwrite),
                                operation
                                    .options
                                    .as_ref()
                                    .and_then(|options| options.ignore_if_exists),
                            ),
                        })
                    }
                    DocumentChangeOperation::Op(ResourceOp::Delete(operation)) => {
                        Ok(LanguageEditEntry::Delete {
                            path: file_path(&operation.uri).ok_or_else(|| {
                                "workspace delete target is not a file URI".to_owned()
                            })?,
                            missing: if operation
                                .options
                                .as_ref()
                                .and_then(|options| options.ignore_if_not_exists)
                                == Some(true)
                            {
                                LanguageMissingTargetBehavior::Ignore
                            } else {
                                LanguageMissingTargetBehavior::Error
                            },
                            mode: if operation
                                .options
                                .as_ref()
                                .and_then(|options| options.recursive)
                                == Some(true)
                            {
                                LanguageDeleteMode::Recursive
                            } else {
                                LanguageDeleteMode::FileOrEmptyDirectory
                            },
                        })
                    }
                })
                .collect::<Result<Vec<_>, _>>()?,
        }
    } else {
        edit.changes
            .unwrap_or_default()
            .into_iter()
            .map(|(uri, edits)| {
                Ok(LanguageEditEntry::TextDocument(
                    LanguageWorkspaceDocumentEdit {
                        path: file_path(&uri)
                            .ok_or_else(|| "workspace edit target is not a file URI".to_owned())?,
                        server_version: None,
                        edits: edits.into_iter().map(project_workspace_text_edit).collect(),
                    },
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    if !has_document_changes {
        entries.sort_by(|left, right| workspace_entry_path(left).cmp(workspace_entry_path(right)));
    }
    Ok(LanguageEdit {
        encoding: language_position_encoding(encoding),
        entries,
    })
}

fn existing_target_behavior(
    overwrite: Option<bool>,
    ignore: Option<bool>,
) -> LanguageExistingTargetBehavior {
    if overwrite == Some(true) {
        LanguageExistingTargetBehavior::Overwrite
    } else if ignore == Some(true) {
        LanguageExistingTargetBehavior::Ignore
    } else {
        LanguageExistingTargetBehavior::Error
    }
}

fn workspace_entry_path(entry: &LanguageEditEntry) -> &PathBuf {
    match entry {
        LanguageEditEntry::TextDocument(edit) => &edit.path,
        LanguageEditEntry::Create { path, .. } | LanguageEditEntry::Delete { path, .. } => path,
        LanguageEditEntry::Rename { source, .. } => source,
    }
}

fn project_text_document_edit(
    edit: TextDocumentEdit,
) -> Result<LanguageWorkspaceDocumentEdit, String> {
    Ok(LanguageWorkspaceDocumentEdit {
        path: file_path(&edit.text_document.uri)
            .ok_or_else(|| "workspace edit target is not a file URI".to_owned())?,
        server_version: edit.text_document.version,
        edits: edit
            .edits
            .into_iter()
            .map(|edit| match edit {
                OneOf::Left(edit) => project_workspace_text_edit(edit),
                OneOf::Right(edit) => project_workspace_text_edit(edit.text_edit),
            })
            .collect(),
    })
}

fn project_workspace_text_edit(edit: TextEdit) -> LanguageWorkspaceTextEdit {
    LanguageWorkspaceTextEdit {
        range: location_range(edit.range),
        new_text: edit.new_text,
    }
}

fn project_workspace_symbol(
    name: String,
    kind: SymbolKind,
    container_name: Option<String>,
    uri: Uri,
    range: Range,
    encoding: &PositionEncodingKind,
) -> Option<LanguageSymbol> {
    Some(LanguageSymbol {
        name,
        symbol_kind: serde_json::to_value(kind)
            .ok()?
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())?,
        container_name,
        path: file_path(&uri)?,
        range: location_range(range),
        encoding: language_position_encoding(encoding),
    })
}

fn project_hierarchy_entries(
    request_id: LanguageRequestId,
    kind: LanguageHierarchyKind,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    entries: Vec<LanguageHierarchyEntry>,
) -> LanguageHierarchyResult {
    LanguageHierarchyResult {
        request_id,
        kind,
        source_path,
        source_revision,
        entries,
    }
}

fn project_call_item(
    item: CallHierarchyItem,
    encoding: &PositionEncodingKind,
) -> Option<LanguageHierarchyItem> {
    project_hierarchy_item(
        item.name,
        item.kind,
        item.detail,
        item.uri,
        item.range,
        item.selection_range,
        item.data,
        encoding,
    )
}

fn project_type_item(
    item: TypeHierarchyItem,
    encoding: &PositionEncodingKind,
) -> Option<LanguageHierarchyItem> {
    project_hierarchy_item(
        item.name,
        item.kind,
        item.detail,
        item.uri,
        item.range,
        item.selection_range,
        item.data,
        encoding,
    )
}

fn project_hierarchy_item(
    name: String,
    kind: SymbolKind,
    detail: Option<String>,
    uri: Uri,
    range: Range,
    selection_range: Range,
    data: Option<Value>,
    encoding: &PositionEncodingKind,
) -> Option<LanguageHierarchyItem> {
    Some(LanguageHierarchyItem {
        name,
        symbol_kind: serde_json::to_value(kind)
            .ok()?
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())?,
        detail,
        path: file_path(&uri)?,
        range: location_range(range),
        selection_range: location_range(selection_range),
        encoding: language_position_encoding(encoding),
        data,
    })
}

fn language_position_encoding(encoding: &PositionEncodingKind) -> LanguagePositionEncoding {
    if *encoding == PositionEncodingKind::UTF8 {
        LanguagePositionEncoding::Utf8
    } else {
        LanguagePositionEncoding::Utf16
    }
}

fn symbol_kind(value: u32) -> Option<SymbolKind> {
    serde_json::from_value(Value::from(value)).ok()
}

fn protocol_location_range(range: LanguageLocationRange) -> Range {
    Range::new(
        Position::new(range.start.row, range.start.character),
        Position::new(range.end.row, range.end.character),
    )
}

fn file_uri(path: &std::path::Path) -> Option<Uri> {
    let url = url::Url::from_file_path(path).ok()?;
    url.as_str().parse().ok()
}

fn project_location_ranges(
    request_id: LanguageRequestId,
    kind: LanguageLocationKind,
    source_path: PathBuf,
    source_revision: LanguageDocumentRevision,
    encoding: &PositionEncodingKind,
    ranges: Vec<(Uri, Range, Range)>,
) -> LanguageLocations {
    let encoding = language_position_encoding(encoding);
    LanguageLocations {
        request_id,
        kind,
        source_path,
        source_revision,
        targets: ranges
            .into_iter()
            .filter_map(|(uri, range, selection_range)| {
                file_path(&uri).map(|path| LanguageLocationTarget {
                    path,
                    range: location_range(range),
                    selection_range: location_range(selection_range),
                    encoding,
                })
            })
            .collect(),
    }
}

fn location_range(range: Range) -> LanguageLocationRange {
    LanguageLocationRange {
        start: LanguageLocationPosition {
            row: range.start.line,
            character: range.start.character,
        },
        end: LanguageLocationPosition {
            row: range.end.line,
            character: range.end.character,
        },
    }
}

fn project_completion_item(
    item: CompletionItem,
    request_position: LanguageDocumentPosition,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageCompletionItem> {
    if item.label.trim().is_empty() {
        return None;
    }
    let provider_data = serde_json::to_value(&item).ok()?;
    let documentation = item.documentation.map(documentation_text).filter(non_blank);
    let insert_text = item.insert_text.unwrap_or_else(|| item.label.clone());
    let edit = match item.text_edit {
        Some(edit) => completion_edit(edit, text, encoding),
        None => insertion_edit(request_position, text, &insert_text),
    }?;
    if !completion_edit_matches_request(&edit, request_position, text) {
        return None;
    }
    let mut additional_text_edits = item
        .additional_text_edits
        .unwrap_or_default()
        .into_iter()
        .map(|edit| language_text_edit(edit, text, encoding))
        .collect::<Option<Vec<_>>>()?;
    additional_text_edits.sort_by_key(|edit| edit.range.byte_range().start);
    if completion_edits_overlap(&edit, &additional_text_edits) {
        return None;
    }
    let mut commit_characters = Vec::new();
    for character in item.commit_characters.unwrap_or_default() {
        if completion_character(&character) && !commit_characters.contains(&character) {
            commit_characters.push(character);
        }
    }
    Some(LanguageCompletionItem {
        label: item.label,
        kind: completion_item_kind(item.kind),
        detail: item.detail.filter(non_blank),
        documentation,
        filter_text: item.filter_text.filter(non_blank),
        sort_text: item.sort_text.filter(non_blank),
        preselect: item.preselect,
        commit_characters,
        insert_text_format: if item.insert_text_format == Some(InsertTextFormat::SNIPPET) {
            LanguageCompletionInsertTextFormat::Snippet
        } else {
            LanguageCompletionInsertTextFormat::PlainText
        },
        edit: Some(edit),
        additional_text_edits,
        command: item.command.map(|command| LanguageCommand {
            id: command.command,
            title: command.title,
            arguments: command.arguments.unwrap_or_default(),
        }),
        provider_data,
    })
}

pub(crate) fn project_resolved_completion(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    item: CompletionItem,
) -> LanguageCompletionDetails {
    LanguageCompletionDetails {
        request_id,
        path,
        revision,
        detail: item.detail.filter(non_blank),
        documentation: item.documentation.map(documentation_text).filter(non_blank),
    }
}

pub(crate) fn project_document_diagnostics(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &PositionEncodingKind,
    response: DocumentDiagnosticReportResult,
) -> Result<LanguagePulledDiagnostics, String> {
    let report = match response {
        DocumentDiagnosticReportResult::Report(DocumentDiagnosticReport::Full(report)) => {
            LanguagePulledDiagnosticReport::Full(
                report
                    .full_document_diagnostic_report
                    .items
                    .into_iter()
                    .filter_map(|diagnostic| project_diagnostic(text, diagnostic, encoding))
                    .collect(),
            )
        }
        DocumentDiagnosticReportResult::Report(DocumentDiagnosticReport::Unchanged(_)) => {
            LanguagePulledDiagnosticReport::Unchanged
        }
        DocumentDiagnosticReportResult::Partial(_) => {
            return Err("document diagnostic partial result omitted its primary report".into());
        }
    };
    Ok(LanguagePulledDiagnostics {
        request_id,
        path,
        revision,
        report,
    })
}

pub(crate) fn protocol_completion_item(data: Value) -> Result<CompletionItem, String> {
    serde_json::from_value(data)
        .map_err(|error| format!("invalid completion resolve payload: {error}"))
}

fn language_text_edit(
    edit: TextEdit,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageTextEdit> {
    Some(LanguageTextEdit {
        range: LanguageTextRange::new(byte_range_for_lsp_range(
            text,
            edit.range.start,
            edit.range.end,
            encoding,
        )?),
        new_text: edit.new_text,
    })
}

fn completion_edits_overlap(primary: &LanguageTextEdit, additional: &[LanguageTextEdit]) -> bool {
    let mut ranges = Vec::with_capacity(additional.len() + 1);
    ranges.push(primary.range.byte_range());
    ranges.extend(additional.iter().map(|edit| edit.range.byte_range()));
    ranges.sort_by_key(|range| range.start);
    ranges.windows(2).any(|pair| pair[1].start <= pair[0].end)
}

fn completion_edit_matches_request(
    edit: &LanguageTextEdit,
    request_position: LanguageDocumentPosition,
    text: &str,
) -> bool {
    let Some(request_offset) = byte_offset_for_position(
        text,
        Position::new(request_position.row, request_position.byte_offset),
        &PositionEncodingKind::UTF8,
    ) else {
        return false;
    };
    let request_row = usize::try_from(request_position.row).unwrap_or(usize::MAX);
    let range = edit.range.byte_range();
    range.start <= request_offset
        && range.end >= request_offset
        && text[..range.start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            == request_row
        && text[..range.end]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            == request_row
}

fn completion_character(value: &str) -> bool {
    value != "\n" && value != "\r" && value.chars().count() == 1
}

fn non_blank(value: &String) -> bool {
    !value.trim().is_empty()
}

fn completion_item_kind(kind: Option<CompletionItemKind>) -> LanguageCompletionItemKind {
    match kind {
        Some(CompletionItemKind::METHOD) => LanguageCompletionItemKind::Method,
        Some(CompletionItemKind::FUNCTION) => LanguageCompletionItemKind::Function,
        Some(CompletionItemKind::CONSTRUCTOR) => LanguageCompletionItemKind::Constructor,
        Some(CompletionItemKind::FIELD) => LanguageCompletionItemKind::Field,
        Some(CompletionItemKind::VARIABLE) => LanguageCompletionItemKind::Variable,
        Some(CompletionItemKind::CLASS) => LanguageCompletionItemKind::Class,
        Some(CompletionItemKind::INTERFACE) => LanguageCompletionItemKind::Interface,
        Some(CompletionItemKind::MODULE) => LanguageCompletionItemKind::Module,
        Some(CompletionItemKind::PROPERTY) => LanguageCompletionItemKind::Property,
        Some(CompletionItemKind::UNIT) => LanguageCompletionItemKind::Unit,
        Some(CompletionItemKind::VALUE) => LanguageCompletionItemKind::Value,
        Some(CompletionItemKind::ENUM) | Some(CompletionItemKind::ENUM_MEMBER) => {
            LanguageCompletionItemKind::Enum
        }
        Some(CompletionItemKind::KEYWORD) => LanguageCompletionItemKind::Keyword,
        Some(CompletionItemKind::SNIPPET) => LanguageCompletionItemKind::Snippet,
        Some(CompletionItemKind::FILE) => LanguageCompletionItemKind::File,
        Some(CompletionItemKind::FOLDER) => LanguageCompletionItemKind::Folder,
        Some(CompletionItemKind::REFERENCE) => LanguageCompletionItemKind::Reference,
        Some(CompletionItemKind::TYPE_PARAMETER) => LanguageCompletionItemKind::TypeParameter,
        _ => LanguageCompletionItemKind::Text,
    }
}

fn insertion_edit(
    position: LanguageDocumentPosition,
    text: &str,
    new_text: &str,
) -> Option<LanguageTextEdit> {
    let offset = byte_offset_for_position(
        text,
        Position::new(position.row, position.byte_offset),
        &PositionEncodingKind::UTF8,
    )?;
    Some(LanguageTextEdit {
        range: LanguageTextRange::new(offset..offset),
        new_text: new_text.into(),
    })
}

fn completion_edit(
    edit: CompletionTextEdit,
    text: &str,
    encoding: &PositionEncodingKind,
) -> Option<LanguageTextEdit> {
    let (range, new_text) = match edit {
        CompletionTextEdit::Edit(edit) => (edit.range, edit.new_text),
        CompletionTextEdit::InsertAndReplace(edit) => (edit.replace, edit.new_text),
    };
    Some(LanguageTextEdit {
        range: LanguageTextRange::new(byte_range_for_lsp_range(
            text,
            range.start,
            range.end,
            encoding,
        )?),
        new_text,
    })
}

fn hover_contents(contents: HoverContents) -> String {
    match contents {
        HoverContents::Scalar(value) => marked_string(value),
        HoverContents::Array(values) => values
            .into_iter()
            .map(marked_string)
            .collect::<Vec<_>>()
            .join("\n\n"),
        HoverContents::Markup(content) => content.value,
    }
}

fn marked_string(value: MarkedString) -> String {
    match value {
        MarkedString::String(value) => value,
        MarkedString::LanguageString(LanguageString { language, value }) => {
            format!("```{language}\n{value}\n```")
        }
    }
}

fn documentation_text(documentation: Documentation) -> String {
    match documentation {
        Documentation::String(value) => value,
        Documentation::MarkupContent(MarkupContent { value, .. }) => value,
    }
}

fn utf16_label_range(label: &str, start: u32, end: u32) -> Option<String> {
    if start > end {
        return None;
    }
    let start = utf16_offset_to_byte(label, start)?;
    let end = utf16_offset_to_byte(label, end)?;
    Some(label[start..end].to_owned())
}

fn utf16_offset_to_byte(value: &str, requested: u32) -> Option<usize> {
    let requested = usize::try_from(requested).ok()?;
    let mut utf16 = 0usize;
    for (byte, character) in value.char_indices() {
        if utf16 == requested {
            return Some(byte);
        }
        utf16 += character.len_utf16();
        if utf16 > requested {
            return None;
        }
    }
    (utf16 == requested).then_some(value.len())
}

fn source_line(text: &str, requested: usize) -> Option<&str> {
    let mut lines = text.split('\n');
    let line = lines.nth(requested)?;
    Some(line.strip_suffix('\r').unwrap_or(line))
}

pub(crate) fn file_path(uri: &Uri) -> Option<PathBuf> {
    let url = url::Url::parse(&uri.to_string()).ok()?;
    url.to_file_path().ok()
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
