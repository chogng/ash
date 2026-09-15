//! Capability-gated request execution and revision-fresh result delivery.

use super::*;

struct CancellableLanguageServerClient {
    client: LanguageServerClient,
    cancellation: ash_async_utils::CancellationToken,
}

impl CancellableLanguageServerClient {
    fn new(client: LanguageServerClient, cancellation: ash_async_utils::CancellationToken) -> Self {
        Self {
            client,
            cancellation,
        }
    }

    async fn request<R>(&self, params: R::Params) -> Result<R::Result, ash_lsp::LanguageServerError>
    where
        R: ash_lsp::lsp_types::request::Request,
    {
        self.client
            .request_with_cancellation::<R>(params, &self.cancellation)
            .await
    }
}

impl std::ops::Deref for CancellableLanguageServerClient {
    type Target = LanguageServerClient;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}
use crate::document_features::{
    project_code_lenses, project_color_presentations, project_document_colors,
    project_document_links, project_document_symbols, project_folding_ranges, protocol_code_lens,
    protocol_color, protocol_document_link, protocol_range,
};
use crate::requests::{
    project_call_hierarchy_items, project_code_actions, project_completions,
    project_document_diagnostics, project_formatting_edits, project_hover, project_incoming_calls,
    project_inlay_hints, project_linked_editing_ranges, project_locations, project_outgoing_calls,
    project_references, project_rename_preparation, project_resolved_code_action,
    project_resolved_completion, project_signature_help, project_type_hierarchy_items,
    project_workspace_edit, project_workspace_symbols, protocol_call_hierarchy_item,
    protocol_code_action, protocol_completion_item, protocol_position,
    protocol_type_hierarchy_item,
};
use crate::semantic_tokens::{project_semantic_tokens, semantic_tokens_options};
use crate::{
    LanguageCodeLens, LanguageCodeLenses, LanguageColor, LanguageColorPresentations,
    LanguageCommand, LanguageCommandResult, LanguageCompletionDetails, LanguageCompletionTrigger,
    LanguageDiagnostic, LanguageDiagnosticSeverity, LanguageDocumentColors, LanguageDocumentLink,
    LanguageDocumentLinks, LanguageDocumentSymbols, LanguageFoldingRanges, LanguageHierarchyItem,
    LanguageHierarchyKind, LanguageLocationKind, LanguagePulledDiagnosticReport,
    LanguagePulledDiagnostics, LanguageSemanticTokens, LanguageServerCapabilities,
    LanguageServerFeature, LanguageSignatureHelpTrigger, LanguageTextRange,
};
use ash_lsp::lsp_types::request::{
    CallHierarchyIncomingCalls, CallHierarchyOutgoingCalls, CallHierarchyPrepare,
    CodeActionRequest, CodeActionResolveRequest, CodeLensRequest, CodeLensResolve,
    ColorPresentationRequest, Completion, DocumentColor, DocumentDiagnosticRequest,
    DocumentLinkRequest, DocumentLinkResolve, DocumentSymbolRequest, FoldingRangeRequest,
    Formatting, GotoDeclaration, GotoDefinition, GotoImplementation, GotoTypeDefinition,
    HoverRequest, InlayHintRequest, LinkedEditingRange, PrepareRenameRequest, RangeFormatting,
    References, Rename, ResolveCompletionItem, SemanticTokensFullRequest, SignatureHelpRequest,
    TypeHierarchyPrepare, TypeHierarchySubtypes, TypeHierarchySupertypes, WorkspaceSymbolRequest,
};
use ash_lsp::lsp_types::{
    CallHierarchyIncomingCallsParams, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    CallHierarchyServerCapability, CodeActionContext, CodeActionKind, CodeActionParams,
    CodeActionProviderCapability, CodeActionTriggerKind, CodeLensParams, ColorPresentationParams,
    ColorProviderCapability, CompletionParams, CompletionTriggerKind, DeclarationCapability,
    Diagnostic, DiagnosticSeverity, DocumentColorParams, DocumentDiagnosticParams,
    DocumentFormattingParams, DocumentLinkParams, DocumentRangeFormattingParams,
    DocumentSymbolParams, ExecuteCommandParams, FoldingRangeParams, FoldingRangeProviderCapability,
    FormattingOptions, GotoDefinitionParams, HoverParams, ImplementationProviderCapability,
    InlayHintParams, LinkedEditingRangeParams, LinkedEditingRangeServerCapabilities,
    NumberOrString, OneOf, PartialResultParams, PositionEncodingKind, ReferenceContext,
    ReferenceParams, RenameParams, SemanticTokensFullOptions, SemanticTokensParams,
    SignatureHelpContext, SignatureHelpParams, SignatureHelpTriggerKind, TextDocumentIdentifier,
    TextDocumentPositionParams, TypeDefinitionProviderCapability, TypeHierarchyPrepareParams,
    TypeHierarchySubtypesParams, TypeHierarchySupertypesParams, WorkDoneProgressParams,
    WorkspaceSymbolParams,
};

pub(super) enum PendingLanguageRequest {
    Hover {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    Completion {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        trigger: LanguageCompletionTrigger,
    },
    ResolveCompletion {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        provider_data: serde_json::Value,
    },
    ExecuteCommand {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        command: LanguageCommand,
    },
    Definition {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    Declaration {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    Implementation {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    TypeDefinition {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    References {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        include_declaration: bool,
    },
    PrepareCallHierarchy {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    IncomingCalls {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    },
    OutgoingCalls {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    },
    PrepareTypeHierarchy {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    Supertypes {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    },
    Subtypes {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    },
    PrepareRename {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    Rename {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        new_name: String,
    },
    CodeActions {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        range: LanguageLocationRange,
        diagnostics: Vec<LanguageDiagnostic>,
        only: Vec<String>,
    },
    ResolveCodeAction {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        provider_data: serde_json::Value,
    },
    DocumentFormatting {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        options: LanguageFormattingOptions,
    },
    RangeFormatting {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
        options: LanguageFormattingOptions,
    },
    SignatureHelp {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        trigger: LanguageSignatureHelpTrigger,
    },
    InlayHints {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
    },
    LinkedEditingRanges {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    },
    SemanticTokens {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    DocumentSymbols {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    CodeLenses {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    ResolveCodeLens {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        lens: LanguageCodeLens,
    },
    DocumentLinks {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    ResolveDocumentLink {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        link: LanguageDocumentLink,
    },
    DocumentColors {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    ColorPresentations {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
        color: LanguageColor,
    },
    FoldingRanges {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    DocumentDiagnostics {
        id: LanguageRequestId,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
}

impl PendingLanguageRequest {
    pub(super) const fn id(&self) -> LanguageRequestId {
        match self {
            Self::Hover { id, .. }
            | Self::Completion { id, .. }
            | Self::ResolveCompletion { id, .. }
            | Self::ExecuteCommand { id, .. }
            | Self::Declaration { id, .. }
            | Self::Definition { id, .. }
            | Self::Implementation { id, .. }
            | Self::TypeDefinition { id, .. }
            | Self::References { id, .. }
            | Self::PrepareCallHierarchy { id, .. }
            | Self::IncomingCalls { id, .. }
            | Self::OutgoingCalls { id, .. }
            | Self::PrepareTypeHierarchy { id, .. }
            | Self::Supertypes { id, .. }
            | Self::Subtypes { id, .. } => *id,
            Self::PrepareRename { id, .. }
            | Self::Rename { id, .. }
            | Self::CodeActions { id, .. }
            | Self::ResolveCodeAction { id, .. }
            | Self::DocumentFormatting { id, .. }
            | Self::RangeFormatting { id, .. } => *id,
            Self::SignatureHelp { id, .. } => *id,
            Self::InlayHints { id, .. } => *id,
            Self::LinkedEditingRanges { id, .. } => *id,
            Self::SemanticTokens { id, .. }
            | Self::DocumentSymbols { id, .. }
            | Self::CodeLenses { id, .. }
            | Self::ResolveCodeLens { id, .. }
            | Self::DocumentLinks { id, .. }
            | Self::ResolveDocumentLink { id, .. }
            | Self::DocumentColors { id, .. }
            | Self::ColorPresentations { id, .. }
            | Self::FoldingRanges { id, .. }
            | Self::DocumentDiagnostics { id, .. } => *id,
        }
    }

    const fn kind(&self) -> LanguageRequestKind {
        match self {
            Self::Hover { .. } => LanguageRequestKind::Hover,
            Self::Completion { .. } => LanguageRequestKind::Completion,
            Self::ResolveCompletion { .. } => LanguageRequestKind::ResolveCompletion,
            Self::ExecuteCommand { .. } => LanguageRequestKind::ExecuteCommand,
            Self::Declaration { .. } => LanguageRequestKind::Declaration,
            Self::Definition { .. } => LanguageRequestKind::Definition,
            Self::Implementation { .. } => LanguageRequestKind::Implementation,
            Self::TypeDefinition { .. } => LanguageRequestKind::TypeDefinition,
            Self::References { .. } => LanguageRequestKind::References,
            Self::PrepareCallHierarchy { .. } => LanguageRequestKind::PrepareCallHierarchy,
            Self::IncomingCalls { .. } => LanguageRequestKind::IncomingCalls,
            Self::OutgoingCalls { .. } => LanguageRequestKind::OutgoingCalls,
            Self::PrepareTypeHierarchy { .. } => LanguageRequestKind::PrepareTypeHierarchy,
            Self::Supertypes { .. } => LanguageRequestKind::Supertypes,
            Self::Subtypes { .. } => LanguageRequestKind::Subtypes,
            Self::PrepareRename { .. } => LanguageRequestKind::PrepareRename,
            Self::Rename { .. } => LanguageRequestKind::Rename,
            Self::CodeActions { .. } => LanguageRequestKind::CodeActions,
            Self::ResolveCodeAction { .. } => LanguageRequestKind::ResolveCodeAction,
            Self::DocumentFormatting { .. } => LanguageRequestKind::DocumentFormatting,
            Self::RangeFormatting { .. } => LanguageRequestKind::RangeFormatting,
            Self::SignatureHelp { .. } => LanguageRequestKind::SignatureHelp,
            Self::InlayHints { .. } => LanguageRequestKind::InlayHints,
            Self::LinkedEditingRanges { .. } => LanguageRequestKind::LinkedEditingRanges,
            Self::SemanticTokens { .. } => LanguageRequestKind::SemanticTokens,
            Self::DocumentSymbols { .. } => LanguageRequestKind::DocumentSymbols,
            Self::CodeLenses { .. } => LanguageRequestKind::CodeLenses,
            Self::ResolveCodeLens { .. } => LanguageRequestKind::ResolveCodeLens,
            Self::DocumentLinks { .. } => LanguageRequestKind::DocumentLinks,
            Self::ResolveDocumentLink { .. } => LanguageRequestKind::ResolveDocumentLink,
            Self::DocumentColors { .. } => LanguageRequestKind::DocumentColors,
            Self::ColorPresentations { .. } => LanguageRequestKind::ColorPresentations,
            Self::FoldingRanges { .. } => LanguageRequestKind::FoldingRanges,
            Self::DocumentDiagnostics { .. } => LanguageRequestKind::DocumentDiagnostics,
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Hover { path, .. }
            | Self::Completion { path, .. }
            | Self::ResolveCompletion { path, .. }
            | Self::ExecuteCommand { path, .. }
            | Self::Declaration { path, .. }
            | Self::Definition { path, .. }
            | Self::Implementation { path, .. }
            | Self::TypeDefinition { path, .. }
            | Self::References { path, .. }
            | Self::PrepareCallHierarchy { path, .. }
            | Self::IncomingCalls { path, .. }
            | Self::OutgoingCalls { path, .. }
            | Self::PrepareTypeHierarchy { path, .. }
            | Self::Supertypes { path, .. }
            | Self::Subtypes { path, .. } => path,
            Self::PrepareRename { path, .. }
            | Self::Rename { path, .. }
            | Self::CodeActions { path, .. }
            | Self::ResolveCodeAction { path, .. }
            | Self::DocumentFormatting { path, .. }
            | Self::RangeFormatting { path, .. } => path,
            Self::SignatureHelp { path, .. } => path,
            Self::InlayHints { path, .. } => path,
            Self::LinkedEditingRanges { path, .. } => path,
            Self::SemanticTokens { path, .. }
            | Self::DocumentSymbols { path, .. }
            | Self::CodeLenses { path, .. }
            | Self::ResolveCodeLens { path, .. }
            | Self::DocumentLinks { path, .. }
            | Self::ResolveDocumentLink { path, .. }
            | Self::DocumentColors { path, .. }
            | Self::ColorPresentations { path, .. }
            | Self::FoldingRanges { path, .. }
            | Self::DocumentDiagnostics { path, .. } => path,
        }
    }

    const fn revision(&self) -> LanguageDocumentRevision {
        match self {
            Self::Hover { revision, .. }
            | Self::Completion { revision, .. }
            | Self::ResolveCompletion { revision, .. }
            | Self::ExecuteCommand { revision, .. }
            | Self::Declaration { revision, .. }
            | Self::Definition { revision, .. }
            | Self::Implementation { revision, .. }
            | Self::TypeDefinition { revision, .. }
            | Self::References { revision, .. }
            | Self::PrepareCallHierarchy { revision, .. }
            | Self::IncomingCalls { revision, .. }
            | Self::OutgoingCalls { revision, .. }
            | Self::PrepareTypeHierarchy { revision, .. }
            | Self::Supertypes { revision, .. }
            | Self::Subtypes { revision, .. } => *revision,
            Self::PrepareRename { revision, .. }
            | Self::Rename { revision, .. }
            | Self::CodeActions { revision, .. }
            | Self::ResolveCodeAction { revision, .. }
            | Self::DocumentFormatting { revision, .. }
            | Self::RangeFormatting { revision, .. } => *revision,
            Self::SignatureHelp { revision, .. } => *revision,
            Self::InlayHints { revision, .. } => *revision,
            Self::LinkedEditingRanges { revision, .. } => *revision,
            Self::SemanticTokens { revision, .. }
            | Self::DocumentSymbols { revision, .. }
            | Self::CodeLenses { revision, .. }
            | Self::ResolveCodeLens { revision, .. }
            | Self::DocumentLinks { revision, .. }
            | Self::ResolveDocumentLink { revision, .. }
            | Self::DocumentColors { revision, .. }
            | Self::ColorPresentations { revision, .. }
            | Self::FoldingRanges { revision, .. }
            | Self::DocumentDiagnostics { revision, .. } => *revision,
        }
    }

    const fn position(&self) -> Option<LanguageDocumentPosition> {
        match self {
            Self::Hover { position, .. }
            | Self::Completion { position, .. }
            | Self::Declaration { position, .. }
            | Self::Definition { position, .. }
            | Self::Implementation { position, .. }
            | Self::TypeDefinition { position, .. }
            | Self::References { position, .. }
            | Self::PrepareCallHierarchy { position, .. }
            | Self::PrepareTypeHierarchy { position, .. } => Some(*position),
            Self::SignatureHelp { position, .. } => Some(*position),
            Self::LinkedEditingRanges { position, .. } => Some(*position),
            Self::PrepareRename { position, .. } | Self::Rename { position, .. } => Some(*position),
            Self::ResolveCompletion { .. }
            | Self::ExecuteCommand { .. }
            | Self::IncomingCalls { .. }
            | Self::OutgoingCalls { .. }
            | Self::Supertypes { .. }
            | Self::Subtypes { .. } => None,
            Self::CodeActions { .. }
            | Self::ResolveCodeAction { .. }
            | Self::DocumentFormatting { .. }
            | Self::RangeFormatting { .. } => None,
            Self::InlayHints { .. } => None,
            Self::SemanticTokens { .. }
            | Self::DocumentSymbols { .. }
            | Self::CodeLenses { .. }
            | Self::ResolveCodeLens { .. }
            | Self::DocumentLinks { .. }
            | Self::ResolveDocumentLink { .. }
            | Self::DocumentColors { .. }
            | Self::ColorPresentations { .. }
            | Self::FoldingRanges { .. }
            | Self::DocumentDiagnostics { .. } => None,
        }
    }
}

pub(super) enum CompletedLanguageRequest {
    Hover(LanguageHover),
    Completions(LanguageCompletions),
    CompletionDetails(LanguageCompletionDetails),
    CommandResult(LanguageCommandResult),
    Locations(LanguageLocations),
    Hierarchy(LanguageHierarchyResult),
    RenamePreparation(LanguageRenamePreparation),
    WorkspaceEdit(LanguageEditResult),
    CodeActions(LanguageCodeActions),
    FormattingEdits(LanguageFormattingEdits),
    SignatureHelp(LanguageSignatureHelp),
    InlayHints(LanguageInlayHints),
    LinkedEditingRanges(LanguageLinkedEditingRanges),
    SemanticTokens(LanguageSemanticTokens),
    DocumentSymbols(LanguageDocumentSymbols),
    CodeLenses(LanguageCodeLenses),
    DocumentLinks(LanguageDocumentLinks),
    DocumentColors(LanguageDocumentColors),
    ColorPresentations(LanguageColorPresentations),
    FoldingRanges(LanguageFoldingRanges),
    PulledDiagnostics(LanguagePulledDiagnostics),
    Empty {
        id: LanguageRequestId,
        kind: LanguageRequestKind,
        path: PathBuf,
        revision: LanguageDocumentRevision,
    },
    Failed {
        id: LanguageRequestId,
        kind: LanguageRequestKind,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        message: String,
    },
}

impl CompletedLanguageRequest {
    fn path(&self) -> &Path {
        match self {
            Self::Hover(result) => &result.path,
            Self::Completions(result) => &result.path,
            Self::CompletionDetails(result) => &result.path,
            Self::CommandResult(result) => &result.path,
            Self::Locations(result) => &result.source_path,
            Self::Hierarchy(result) => &result.source_path,
            Self::RenamePreparation(result) => &result.source_path,
            Self::WorkspaceEdit(result) => &result.source_path,
            Self::CodeActions(result) => &result.source_path,
            Self::FormattingEdits(result) => &result.path,
            Self::SignatureHelp(result) => &result.path,
            Self::InlayHints(result) => &result.path,
            Self::LinkedEditingRanges(result) => &result.path,
            Self::SemanticTokens(result) => &result.path,
            Self::DocumentSymbols(result) => &result.path,
            Self::CodeLenses(result) => &result.path,
            Self::DocumentLinks(result) => &result.path,
            Self::DocumentColors(result) => &result.path,
            Self::ColorPresentations(result) => &result.path,
            Self::FoldingRanges(result) => &result.path,
            Self::PulledDiagnostics(result) => &result.path,
            Self::Empty { path, .. } | Self::Failed { path, .. } => path,
        }
    }

    const fn revision(&self) -> LanguageDocumentRevision {
        match self {
            Self::Hover(result) => result.revision,
            Self::Completions(result) => result.revision,
            Self::CompletionDetails(result) => result.revision,
            Self::CommandResult(result) => result.revision,
            Self::Locations(result) => result.source_revision,
            Self::Hierarchy(result) => result.source_revision,
            Self::RenamePreparation(result) => result.source_revision,
            Self::WorkspaceEdit(result) => result.source_revision,
            Self::CodeActions(result) => result.source_revision,
            Self::FormattingEdits(result) => result.revision,
            Self::SignatureHelp(result) => result.revision,
            Self::InlayHints(result) => result.revision,
            Self::LinkedEditingRanges(result) => result.revision,
            Self::SemanticTokens(result) => result.revision,
            Self::DocumentSymbols(result) => result.revision,
            Self::CodeLenses(result) => result.revision,
            Self::DocumentLinks(result) => result.revision,
            Self::DocumentColors(result) => result.revision,
            Self::ColorPresentations(result) => result.revision,
            Self::FoldingRanges(result) => result.revision,
            Self::PulledDiagnostics(result) => result.revision,
            Self::Empty { revision, .. } | Self::Failed { revision, .. } => *revision,
        }
    }

    fn result_count(&self) -> usize {
        match self {
            Self::Hover(_) | Self::CompletionDetails(_) | Self::CommandResult(_) => 1,
            Self::Completions(result) => result.items.len(),
            Self::Locations(result) => result.targets.len(),
            Self::Hierarchy(result) => result.entries.len(),
            Self::RenamePreparation(result) => usize::from(
                result.range.is_some() || result.default_behavior || result.placeholder.is_some(),
            ),
            Self::WorkspaceEdit(_) => 1,
            Self::CodeActions(result) => result.actions.len(),
            Self::FormattingEdits(result) => result.edits.len(),
            Self::SignatureHelp(result) => result.signatures.len(),
            Self::InlayHints(result) => result.hints.len(),
            Self::LinkedEditingRanges(result) => result.ranges.len(),
            Self::SemanticTokens(result) => result.tokens.len(),
            Self::DocumentSymbols(result) => result.symbols.len(),
            Self::CodeLenses(result) => result.lenses.len(),
            Self::DocumentLinks(result) => result.links.len(),
            Self::DocumentColors(result) => result.colors.len(),
            Self::ColorPresentations(result) => result.presentations.len(),
            Self::FoldingRanges(result) => result.ranges.len(),
            Self::PulledDiagnostics(result) => match &result.report {
                LanguagePulledDiagnosticReport::Full(diagnostics) => diagnostics.len(),
                LanguagePulledDiagnosticReport::Unchanged => 0,
            },
            Self::Empty { .. } | Self::Failed { .. } => 0,
        }
    }
}

impl Supervisor {
    pub(super) fn begin_language_request(&mut self, request: PendingLanguageRequest) {
        let Some(document) = self.documents.get(request.path()) else {
            self.emit_request_failure(&request, "document is not open in the language service");
            return;
        };
        if document.document.revision() != request.revision() || !document.routed {
            self.emit_request_failure(&request, "document revision is stale or not routed");
            return;
        }
        let Some((server_name, server_epoch)) =
            self.server_for_language(document.document.language_id())
        else {
            self.emit_request_failure(&request, "no ready language server supports this document");
            return;
        };
        let Ok(client) = self.router.client_for_document(&document.uri).cloned() else {
            self.emit_request_failure(&request, "document has no active language-server route");
            return;
        };
        if !supports_request(&client, request.kind()) {
            self.emit_request_failure(
                &request,
                "language server does not advertise this capability",
            );
            return;
        }
        let encoding = client.initialization().position_encoding.clone();
        let position = match request.position() {
            Some(position) => {
                match protocol_position(document.document.text(), position, &encoding) {
                    Some(position) => Some(position),
                    None => {
                        self.emit_request_failure(
                            &request,
                            "request position is outside the document snapshot",
                        );
                        return;
                    }
                }
            }
            None => None,
        };
        let uri = document.uri.clone();
        let text = document.document.text().to_owned();
        let generation = self.generation;
        let commands = self.commands.clone();
        let failure_id = request.id();
        let failure_kind = request.kind();
        let failure_path = request.path().to_path_buf();
        let failure_revision = request.revision();
        let kind = request.kind();
        let cold_for_incarnation =
            self.observed_request_kinds
                .insert((server_name.clone(), server_epoch, kind));
        let started = Instant::now();
        let completion_server = server_name.clone();
        let cancellation = ash_async_utils::CancellationSource::new();
        let cancellation_token = cancellation.token();
        let _ = tokio::spawn(async move {
            let result = execute_request(
                client,
                request,
                uri,
                position,
                text,
                encoding,
                cancellation_token,
            )
            .await
            .or_else(|message| {
                Ok(CompletedLanguageRequest::Failed {
                    id: failure_id,
                    kind: failure_kind,
                    path: failure_path,
                    revision: failure_revision,
                    message,
                })
            });
            let _ = commands.send(SupervisorCommand::LanguageRequestCompleted {
                request_id: failure_id,
                server: completion_server,
                generation,
                server_epoch,
                result,
            });
        });
        self.in_flight_requests.insert(
            failure_id,
            InFlightLanguageRequest {
                cancellation,
                kind,
                server: server_name.clone(),
                server_epoch,
                configuration_generation: self.configuration.generation,
                service_generation: generation,
                cold_for_incarnation,
                started,
            },
        );
    }

    pub(super) fn complete_language_request(
        &mut self,
        request_id: LanguageRequestId,
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<CompletedLanguageRequest, String>,
    ) {
        let Some(tracking) = self.in_flight_requests.remove(&request_id) else {
            return;
        };
        if tracking.cancellation.token().is_cancelled() {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
            return;
        }
        if generation != self.generation
            || !self.servers.get(&server).is_some_and(|managed| {
                managed.epoch == server_epoch && managed.phase == ManagedServerPhase::Ready
            })
        {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::StaleDiscarded, 0);
            return;
        }
        let result = match result {
            Ok(result) => result,
            Err(message) => {
                self.record_request_metric(tracking, LanguageRequestMetricOutcome::Failed, 0);
                self.emit_notification(LspManagerNotification::ServerMessage {
                    server: server.to_string(),
                    severity: LanguageServerMessageSeverity::Error,
                    source: super::LanguageServerMessageSource::Service,
                    show: false,
                    message,
                });
                return;
            }
        };
        let fresh = self.documents.get(result.path()).is_some_and(|document| {
            document.routed && document.document.revision() == result.revision()
        });
        if !fresh {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::StaleDiscarded, 0);
            return;
        }
        let outcome = match &result {
            CompletedLanguageRequest::Empty { .. } => LanguageRequestMetricOutcome::Empty,
            CompletedLanguageRequest::Failed { .. } => LanguageRequestMetricOutcome::Failed,
            _ => LanguageRequestMetricOutcome::Delivered,
        };
        let result_count = result.result_count();
        self.record_request_metric(tracking, outcome, result_count);
        match result {
            CompletedLanguageRequest::Hover(result) => {
                self.emit_request_result(LspManagerRequestResult::Hover(result))
            }
            CompletedLanguageRequest::Completions(result) => {
                self.emit_request_result(LspManagerRequestResult::Completions(result))
            }
            CompletedLanguageRequest::CompletionDetails(result) => {
                self.emit_request_result(LspManagerRequestResult::CompletionDetails(result))
            }
            CompletedLanguageRequest::CommandResult(result) => {
                self.emit_request_result(LspManagerRequestResult::CommandResult(result))
            }
            CompletedLanguageRequest::Locations(result) => {
                self.emit_request_result(LspManagerRequestResult::Locations(result))
            }
            CompletedLanguageRequest::Hierarchy(result) => {
                self.emit_request_result(LspManagerRequestResult::Hierarchy(result))
            }
            CompletedLanguageRequest::RenamePreparation(result) => {
                self.emit_request_result(LspManagerRequestResult::RenamePreparation(result))
            }
            CompletedLanguageRequest::WorkspaceEdit(result) => {
                self.emit_request_result(LspManagerRequestResult::WorkspaceEdit(result))
            }
            CompletedLanguageRequest::CodeActions(result) => {
                self.emit_request_result(LspManagerRequestResult::CodeActions(result))
            }
            CompletedLanguageRequest::FormattingEdits(result) => {
                self.emit_request_result(LspManagerRequestResult::FormattingEdits(result))
            }
            CompletedLanguageRequest::SignatureHelp(result) => {
                self.emit_request_result(LspManagerRequestResult::SignatureHelp(result))
            }
            CompletedLanguageRequest::InlayHints(result) => {
                self.emit_request_result(LspManagerRequestResult::InlayHints(result))
            }
            CompletedLanguageRequest::LinkedEditingRanges(result) => {
                self.emit_request_result(LspManagerRequestResult::LinkedEditingRanges(result))
            }
            CompletedLanguageRequest::SemanticTokens(result) => {
                self.emit_request_result(LspManagerRequestResult::SemanticTokens(result))
            }
            CompletedLanguageRequest::DocumentSymbols(result) => {
                self.emit_request_result(LspManagerRequestResult::DocumentSymbols(result))
            }
            CompletedLanguageRequest::CodeLenses(result) => {
                self.emit_request_result(LspManagerRequestResult::CodeLenses(result))
            }
            CompletedLanguageRequest::DocumentLinks(result) => {
                self.emit_request_result(LspManagerRequestResult::DocumentLinks(result))
            }
            CompletedLanguageRequest::DocumentColors(result) => {
                self.emit_request_result(LspManagerRequestResult::DocumentColors(result))
            }
            CompletedLanguageRequest::ColorPresentations(result) => {
                self.emit_request_result(LspManagerRequestResult::ColorPresentations(result))
            }
            CompletedLanguageRequest::FoldingRanges(result) => {
                self.emit_request_result(LspManagerRequestResult::FoldingRanges(result))
            }
            CompletedLanguageRequest::PulledDiagnostics(result) => {
                if let LanguagePulledDiagnosticReport::Full(diagnostics) = &result.report {
                    self.emit_notification(LspManagerNotification::Diagnostics(
                        LanguageDiagnostics::new(
                            result.path.clone(),
                            result.revision,
                            diagnostics.clone(),
                        ),
                    ));
                }
                self.emit_request_result(LspManagerRequestResult::PulledDiagnostics(result));
            }
            CompletedLanguageRequest::Empty {
                id,
                kind,
                path,
                revision,
            } => self.emit_request_result(LspManagerRequestResult::RequestFailed {
                request_id: id,
                kind,
                path,
                revision,
                message: "language server returned no result".into(),
            }),
            CompletedLanguageRequest::Failed {
                id,
                kind,
                path,
                revision,
                message,
            } => self.emit_request_result(LspManagerRequestResult::RequestFailed {
                request_id: id,
                kind,
                path,
                revision,
                message,
            }),
        }
    }

    pub(super) fn server_for_language(
        &self,
        language_id: &str,
    ) -> Option<(LanguageServerName, u64)> {
        self.servers.iter().find_map(|(name, server)| {
            (server.phase == ManagedServerPhase::Ready
                && server
                    .definition
                    .language_ids()
                    .any(|language| language == language_id))
            .then(|| (name.clone(), server.epoch))
        })
    }

    fn emit_request_failure(&self, request: &PendingLanguageRequest, message: &str) {
        self.record_rejected_request(request.kind());
        self.emit_request_result(LspManagerRequestResult::RequestFailed {
            request_id: request.id(),
            kind: request.kind(),
            path: request.path().to_path_buf(),
            revision: request.revision(),
            message: message.into(),
        });
    }

    pub(super) fn cancel_language_request(&mut self, request_id: LanguageRequestId) {
        let Some(tracking) = self.in_flight_requests.remove(&request_id) else {
            return;
        };
        tracking.cancellation.cancel();
        self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
    }

    pub(super) fn cancel_all_language_requests(&mut self) {
        for (_, tracking) in std::mem::take(&mut self.in_flight_requests) {
            tracking.cancellation.cancel();
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
        }
    }

    fn record_rejected_request(&self, kind: LanguageRequestKind) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        metrics.record(LanguageRequestMetric {
            kind,
            server: None,
            server_incarnation: None,
            configuration_generation: self.configuration.generation,
            service_generation: self.generation,
            cold_for_incarnation: false,
            elapsed_millis: 0,
            result_count: 0,
            outcome: LanguageRequestMetricOutcome::Rejected,
        });
    }

    pub(super) fn record_request_metric(
        &self,
        tracking: InFlightLanguageRequest,
        outcome: LanguageRequestMetricOutcome,
        result_count: usize,
    ) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        metrics.record(LanguageRequestMetric {
            kind: tracking.kind,
            server: Some(tracking.server.to_string()),
            server_incarnation: Some(tracking.server_epoch),
            configuration_generation: tracking.configuration_generation,
            service_generation: tracking.service_generation,
            cold_for_incarnation: tracking.cold_for_incarnation,
            elapsed_millis: u64::try_from(tracking.started.elapsed().as_millis())
                .unwrap_or(u64::MAX),
            result_count,
            outcome,
        });
    }
}

async fn execute_request(
    client: LanguageServerClient,
    request: PendingLanguageRequest,
    uri: Uri,
    position: Option<ash_lsp::lsp_types::Position>,
    text: String,
    encoding: PositionEncodingKind,
    cancellation: ash_async_utils::CancellationToken,
) -> Result<CompletedLanguageRequest, String> {
    let client = CancellableLanguageServerClient::new(client, cancellation);
    match request {
        PendingLanguageRequest::Hover {
            id, path, revision, ..
        } => {
            let text_document_position = text_document_position(uri, position)?;
            let response = client
                .request::<HoverRequest>(HoverParams {
                    text_document_position_params: text_document_position,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(
                project_hover(id, path.clone(), revision, &text, &encoding, response)
                    .map(CompletedLanguageRequest::Hover)
                    .unwrap_or(CompletedLanguageRequest::Empty {
                        id,
                        kind: LanguageRequestKind::Hover,
                        path,
                        revision,
                    }),
            )
        }
        PendingLanguageRequest::Completion {
            id,
            path,
            revision,
            position: request_position,
            trigger,
        } => {
            let text_document_position = text_document_position(uri, position)?;
            let can_resolve = supports_request(&client, LanguageRequestKind::ResolveCompletion);
            let response = client
                .request::<Completion>(CompletionParams {
                    text_document_position,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                    context: Some(completion_context(trigger)),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::Completions(project_completions(
                id,
                path,
                revision,
                request_position,
                &text,
                &encoding,
                can_resolve,
                response,
            )))
        }
        PendingLanguageRequest::ResolveCompletion {
            id,
            path,
            revision,
            provider_data,
        } => {
            let response = client
                .request::<ResolveCompletionItem>(protocol_completion_item(provider_data)?)
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::CompletionDetails(
                project_resolved_completion(id, path, revision, response),
            ))
        }
        PendingLanguageRequest::ExecuteCommand {
            id,
            path,
            revision,
            command,
        } => {
            if !supports_command(&client, &command.id) {
                return Err("language server did not advertise the requested command".into());
            }
            let response = client
                .request::<ash_lsp::lsp_types::request::ExecuteCommand>(ExecuteCommandParams {
                    command: command.id,
                    arguments: command.arguments,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::CommandResult(
                LanguageCommandResult {
                    request_id: id,
                    path,
                    revision,
                    value: response.unwrap_or(serde_json::Value::Null),
                },
            ))
        }
        PendingLanguageRequest::Definition {
            id, path, revision, ..
        } => {
            let text_document_position = text_document_position(uri, position)?;
            let response = client
                .request::<GotoDefinition>(GotoDefinitionParams {
                    text_document_position_params: text_document_position,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            let result = project_locations(
                id,
                LanguageLocationKind::Definition,
                path.clone(),
                revision,
                &encoding,
                response,
            );
            if result.targets.is_empty() {
                Ok(CompletedLanguageRequest::Empty {
                    id,
                    kind: LanguageRequestKind::Definition,
                    path,
                    revision,
                })
            } else {
                Ok(CompletedLanguageRequest::Locations(result))
            }
        }
        PendingLanguageRequest::Declaration {
            id, path, revision, ..
        } => {
            execute_locations::<GotoDeclaration>(
                client,
                text_document_position(uri, position)?,
                id,
                LanguageRequestKind::Declaration,
                LanguageLocationKind::Declaration,
                path,
                revision,
                encoding,
            )
            .await
        }
        PendingLanguageRequest::Implementation {
            id, path, revision, ..
        } => {
            execute_locations::<GotoImplementation>(
                client,
                text_document_position(uri, position)?,
                id,
                LanguageRequestKind::Implementation,
                LanguageLocationKind::Implementation,
                path,
                revision,
                encoding,
            )
            .await
        }
        PendingLanguageRequest::TypeDefinition {
            id, path, revision, ..
        } => {
            execute_locations::<GotoTypeDefinition>(
                client,
                text_document_position(uri, position)?,
                id,
                LanguageRequestKind::TypeDefinition,
                LanguageLocationKind::TypeDefinition,
                path,
                revision,
                encoding,
            )
            .await
        }
        PendingLanguageRequest::References {
            id,
            path,
            revision,
            include_declaration,
            ..
        } => {
            let text_document_position = text_document_position(uri, position)?;
            let response = client
                .request::<References>(ReferenceParams {
                    text_document_position,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                    context: ReferenceContext {
                        include_declaration,
                    },
                })
                .await
                .map_err(|error| error.to_string())?;
            let result = project_references(id, path.clone(), revision, &encoding, response);
            if result.targets.is_empty() {
                Ok(CompletedLanguageRequest::Empty {
                    id,
                    kind: LanguageRequestKind::References,
                    path,
                    revision,
                })
            } else {
                Ok(CompletedLanguageRequest::Locations(result))
            }
        }
        PendingLanguageRequest::PrepareCallHierarchy {
            id, path, revision, ..
        } => {
            let response = client
                .request::<CallHierarchyPrepare>(CallHierarchyPrepareParams {
                    text_document_position_params: text_document_position(uri, position)?,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_call_hierarchy_items(
                    id,
                    LanguageHierarchyKind::PrepareCall,
                    path.clone(),
                    revision,
                    &encoding,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::PrepareCallHierarchy,
                path,
                revision,
            )
        }
        PendingLanguageRequest::IncomingCalls {
            id,
            path,
            revision,
            item,
        } => {
            let item = protocol_call_hierarchy_item(item)
                .ok_or_else(|| "invalid call hierarchy item".to_owned())?;
            let response = client
                .request::<CallHierarchyIncomingCalls>(CallHierarchyIncomingCallsParams {
                    item,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_incoming_calls(
                    id,
                    path.clone(),
                    revision,
                    &encoding,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::IncomingCalls,
                path,
                revision,
            )
        }
        PendingLanguageRequest::OutgoingCalls {
            id,
            path,
            revision,
            item,
        } => {
            let from_path = item.path.clone();
            let item = protocol_call_hierarchy_item(item)
                .ok_or_else(|| "invalid call hierarchy item".to_owned())?;
            let response = client
                .request::<CallHierarchyOutgoingCalls>(CallHierarchyOutgoingCallsParams {
                    item,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_outgoing_calls(
                    id,
                    path.clone(),
                    revision,
                    &encoding,
                    from_path,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::OutgoingCalls,
                path,
                revision,
            )
        }
        PendingLanguageRequest::PrepareTypeHierarchy {
            id, path, revision, ..
        } => {
            let response = client
                .request::<TypeHierarchyPrepare>(TypeHierarchyPrepareParams {
                    text_document_position_params: text_document_position(uri, position)?,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_type_hierarchy_items(
                    id,
                    LanguageHierarchyKind::PrepareType,
                    path.clone(),
                    revision,
                    &encoding,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::PrepareTypeHierarchy,
                path,
                revision,
            )
        }
        PendingLanguageRequest::Supertypes {
            id,
            path,
            revision,
            item,
        } => {
            let item = protocol_type_hierarchy_item(item)
                .ok_or_else(|| "invalid type hierarchy item".to_owned())?;
            let response = client
                .request::<TypeHierarchySupertypes>(TypeHierarchySupertypesParams {
                    item,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_type_hierarchy_items(
                    id,
                    LanguageHierarchyKind::Supertypes,
                    path.clone(),
                    revision,
                    &encoding,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::Supertypes,
                path,
                revision,
            )
        }
        PendingLanguageRequest::Subtypes {
            id,
            path,
            revision,
            item,
        } => {
            let item = protocol_type_hierarchy_item(item)
                .ok_or_else(|| "invalid type hierarchy item".to_owned())?;
            let response = client
                .request::<TypeHierarchySubtypes>(TypeHierarchySubtypesParams {
                    item,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            hierarchy_result(
                project_type_hierarchy_items(
                    id,
                    LanguageHierarchyKind::Subtypes,
                    path.clone(),
                    revision,
                    &encoding,
                    response.unwrap_or_default(),
                ),
                id,
                LanguageRequestKind::Subtypes,
                path,
                revision,
            )
        }
        PendingLanguageRequest::PrepareRename {
            id, path, revision, ..
        } => {
            let response = client
                .request::<PrepareRenameRequest>(text_document_position(uri, position)?)
                .await
                .map_err(|error| error.to_string())?;
            Ok(
                project_rename_preparation(id, path.clone(), revision, &text, &encoding, response)
                    .map(CompletedLanguageRequest::RenamePreparation)
                    .unwrap_or(CompletedLanguageRequest::Empty {
                        id,
                        kind: LanguageRequestKind::PrepareRename,
                        path,
                        revision,
                    }),
            )
        }
        PendingLanguageRequest::Rename {
            id,
            path,
            revision,
            new_name,
            ..
        } => {
            let response = client
                .request::<Rename>(RenameParams {
                    text_document_position: text_document_position(uri, position)?,
                    new_name,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            project_workspace_edit(id, path, revision, &encoding, response)
                .map(CompletedLanguageRequest::WorkspaceEdit)
        }
        PendingLanguageRequest::CodeActions {
            id,
            path,
            revision,
            range,
            diagnostics,
            only,
        } => {
            let can_resolve = matches!(client.initialization().capabilities.code_action_provider, Some(CodeActionProviderCapability::Options(ref options)) if options.resolve_provider == Some(true));
            let response = client
                .request::<CodeActionRequest>(CodeActionParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    range: protocol_location_range(range),
                    context: CodeActionContext {
                        diagnostics: diagnostics
                            .into_iter()
                            .filter_map(|diagnostic| {
                                protocol_diagnostic(&text, &encoding, diagnostic)
                            })
                            .collect(),
                        only: (!only.is_empty())
                            .then(|| only.into_iter().map(CodeActionKind::from).collect()),
                        trigger_kind: Some(CodeActionTriggerKind::INVOKED),
                    },
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::CodeActions(project_code_actions(
                id,
                path,
                revision,
                &encoding,
                can_resolve,
                response,
            )))
        }
        PendingLanguageRequest::ResolveCodeAction {
            id,
            path,
            revision,
            provider_data,
        } => {
            let response = client
                .request::<CodeActionResolveRequest>(protocol_code_action(provider_data)?)
                .await
                .map_err(|error| error.to_string())?;
            project_resolved_code_action(id, path, revision, &encoding, response)
                .map(CompletedLanguageRequest::CodeActions)
        }
        PendingLanguageRequest::DocumentFormatting {
            id,
            path,
            revision,
            options,
        } => {
            let response = client
                .request::<Formatting>(DocumentFormattingParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    options: protocol_formatting_options(options),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            project_formatting_edits(id, path, revision, &text, &encoding, response)
                .map(CompletedLanguageRequest::FormattingEdits)
        }
        PendingLanguageRequest::RangeFormatting {
            id,
            path,
            revision,
            range,
            options,
        } => {
            let range = protocol_byte_range(&text, range.byte_range(), &encoding)
                .ok_or_else(|| "formatting range is outside the document snapshot".to_owned())?;
            let response = client
                .request::<RangeFormatting>(DocumentRangeFormattingParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    range,
                    options: protocol_formatting_options(options),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            project_formatting_edits(id, path, revision, &text, &encoding, response)
                .map(CompletedLanguageRequest::FormattingEdits)
        }
        PendingLanguageRequest::SignatureHelp {
            id,
            path,
            revision,
            trigger,
            ..
        } => {
            let response = client
                .request::<SignatureHelpRequest>(SignatureHelpParams {
                    context: Some(signature_help_context(trigger)),
                    text_document_position_params: text_document_position(uri, position)?,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(project_signature_help(id, path.clone(), revision, response)
                .map(CompletedLanguageRequest::SignatureHelp)
                .unwrap_or(CompletedLanguageRequest::Empty {
                    id,
                    kind: LanguageRequestKind::SignatureHelp,
                    path,
                    revision,
                }))
        }
        PendingLanguageRequest::InlayHints {
            id,
            path,
            revision,
            range,
        } => {
            let range = protocol_byte_range(&text, range.byte_range(), &encoding)
                .ok_or_else(|| "inlay-hint range is outside the document snapshot".to_owned())?;
            let response = client
                .request::<InlayHintRequest>(InlayHintParams {
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    text_document: TextDocumentIdentifier::new(uri),
                    range,
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::InlayHints(project_inlay_hints(
                id, path, revision, &text, &encoding, response,
            )))
        }
        PendingLanguageRequest::LinkedEditingRanges {
            id, path, revision, ..
        } => {
            let response = client
                .request::<LinkedEditingRange>(LinkedEditingRangeParams {
                    text_document_position_params: text_document_position(uri, position)?,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(project_linked_editing_ranges(
                id,
                path.clone(),
                revision,
                &text,
                &encoding,
                response,
            )
            .map(CompletedLanguageRequest::LinkedEditingRanges)
            .unwrap_or(CompletedLanguageRequest::Empty {
                id,
                kind: LanguageRequestKind::LinkedEditingRanges,
                path,
                revision,
            }))
        }
        PendingLanguageRequest::SemanticTokens { id, path, revision } => {
            let options = semantic_tokens_options(&client)
                .ok_or_else(|| "language server does not advertise semantic tokens".to_owned())?;
            let response = client
                .request::<SemanticTokensFullRequest>(SemanticTokensParams {
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                    text_document: TextDocumentIdentifier::new(uri),
                })
                .await
                .map_err(|error| error.to_string())?;
            project_semantic_tokens(id, path, revision, &text, &encoding, &options, response)
                .map(CompletedLanguageRequest::SemanticTokens)
        }
        PendingLanguageRequest::DocumentSymbols { id, path, revision } => {
            let response = client
                .request::<DocumentSymbolRequest>(DocumentSymbolParams {
                    text_document: TextDocumentIdentifier::new(uri.clone()),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::DocumentSymbols(
                project_document_symbols(id, path, revision, &text, &uri, &encoding, response),
            ))
        }
        PendingLanguageRequest::CodeLenses { id, path, revision } => {
            let response = client
                .request::<CodeLensRequest>(CodeLensParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::CodeLenses(project_code_lenses(
                id,
                path,
                revision,
                &text,
                &encoding,
                response.unwrap_or_default(),
            )))
        }
        PendingLanguageRequest::ResolveCodeLens {
            id,
            path,
            revision,
            lens,
        } => {
            let lens = protocol_code_lens(lens, &text, &encoding)
                .ok_or_else(|| "code lens is outside the document snapshot".to_owned())?;
            let response = client
                .request::<CodeLensResolve>(lens)
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::CodeLenses(project_code_lenses(
                id,
                path,
                revision,
                &text,
                &encoding,
                vec![response],
            )))
        }
        PendingLanguageRequest::DocumentLinks { id, path, revision } => {
            let response = client
                .request::<DocumentLinkRequest>(DocumentLinkParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::DocumentLinks(
                project_document_links(
                    id,
                    path,
                    revision,
                    &text,
                    &encoding,
                    response.unwrap_or_default(),
                ),
            ))
        }
        PendingLanguageRequest::ResolveDocumentLink {
            id,
            path,
            revision,
            link,
        } => {
            let link = protocol_document_link(link, &text, &encoding)
                .ok_or_else(|| "document link is outside the document snapshot".to_owned())?;
            let response = client
                .request::<DocumentLinkResolve>(link)
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::DocumentLinks(
                project_document_links(id, path, revision, &text, &encoding, vec![response]),
            ))
        }
        PendingLanguageRequest::DocumentColors { id, path, revision } => {
            let response = client
                .request::<DocumentColor>(DocumentColorParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::DocumentColors(
                project_document_colors(id, path, revision, &text, &encoding, response),
            ))
        }
        PendingLanguageRequest::ColorPresentations {
            id,
            path,
            revision,
            range,
            color,
        } => {
            let range = protocol_range(&text, range, &encoding).ok_or_else(|| {
                "color presentation range is outside the document snapshot".to_owned()
            })?;
            let response = client
                .request::<ColorPresentationRequest>(ColorPresentationParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    color: protocol_color(color),
                    range,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::ColorPresentations(
                project_color_presentations(id, path, revision, &text, &encoding, response),
            ))
        }
        PendingLanguageRequest::FoldingRanges { id, path, revision } => {
            let response = client
                .request::<FoldingRangeRequest>(FoldingRangeParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::FoldingRanges(
                project_folding_ranges(id, path, revision, &text, response.unwrap_or_default()),
            ))
        }
        PendingLanguageRequest::DocumentDiagnostics { id, path, revision } => {
            let response = client
                .request::<DocumentDiagnosticRequest>(DocumentDiagnosticParams {
                    text_document: TextDocumentIdentifier::new(uri),
                    identifier: None,
                    previous_result_id: None,
                    work_done_progress_params: WorkDoneProgressParams::default(),
                    partial_result_params: PartialResultParams::default(),
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(CompletedLanguageRequest::PulledDiagnostics(
                project_document_diagnostics(id, path, revision, &text, &encoding, response)?,
            ))
        }
    }
}

fn signature_help_context(trigger: LanguageSignatureHelpTrigger) -> SignatureHelpContext {
    let (trigger_kind, trigger_character) = match trigger {
        LanguageSignatureHelpTrigger::Invoked => (SignatureHelpTriggerKind::INVOKED, None),
        LanguageSignatureHelpTrigger::TriggerCharacter(character) => {
            (SignatureHelpTriggerKind::TRIGGER_CHARACTER, Some(character))
        }
        LanguageSignatureHelpTrigger::ContentChange => {
            (SignatureHelpTriggerKind::CONTENT_CHANGE, None)
        }
    };
    SignatureHelpContext {
        trigger_kind,
        trigger_character,
        is_retrigger: false,
        active_signature_help: None,
    }
}

fn protocol_formatting_options(options: LanguageFormattingOptions) -> FormattingOptions {
    FormattingOptions {
        tab_size: options.tab_size,
        insert_spaces: options.insert_spaces,
        properties: Default::default(),
        trim_trailing_whitespace: options.trim_trailing_whitespace,
        insert_final_newline: None,
        trim_final_newlines: None,
    }
}

fn completion_context(trigger: LanguageCompletionTrigger) -> ash_lsp::lsp_types::CompletionContext {
    match trigger {
        LanguageCompletionTrigger::Invoked => ash_lsp::lsp_types::CompletionContext {
            trigger_kind: CompletionTriggerKind::INVOKED,
            trigger_character: None,
        },
        LanguageCompletionTrigger::TriggerCharacter(character) => {
            ash_lsp::lsp_types::CompletionContext {
                trigger_kind: CompletionTriggerKind::TRIGGER_CHARACTER,
                trigger_character: Some(character),
            }
        }
        LanguageCompletionTrigger::IncompleteRefresh => ash_lsp::lsp_types::CompletionContext {
            trigger_kind: CompletionTriggerKind::TRIGGER_FOR_INCOMPLETE_COMPLETIONS,
            trigger_character: None,
        },
    }
}

fn protocol_location_range(range: LanguageLocationRange) -> ash_lsp::lsp_types::Range {
    ash_lsp::lsp_types::Range::new(
        ash_lsp::lsp_types::Position::new(range.start.row, range.start.character),
        ash_lsp::lsp_types::Position::new(range.end.row, range.end.character),
    )
}

fn protocol_diagnostic(
    text: &str,
    encoding: &PositionEncodingKind,
    diagnostic: LanguageDiagnostic,
) -> Option<Diagnostic> {
    let range = protocol_byte_range(text, diagnostic.range.byte_range(), encoding)?;
    Some(Diagnostic {
        range,
        severity: Some(match diagnostic.severity {
            LanguageDiagnosticSeverity::Error => DiagnosticSeverity::ERROR,
            LanguageDiagnosticSeverity::Warning => DiagnosticSeverity::WARNING,
            LanguageDiagnosticSeverity::Information => DiagnosticSeverity::INFORMATION,
            LanguageDiagnosticSeverity::Hint => DiagnosticSeverity::HINT,
        }),
        code: diagnostic.code.map(NumberOrString::String),
        source: diagnostic.source,
        message: diagnostic.message,
        ..Diagnostic::default()
    })
}

fn protocol_byte_range(
    text: &str,
    range: std::ops::Range<usize>,
    encoding: &PositionEncodingKind,
) -> Option<ash_lsp::lsp_types::Range> {
    Some(ash_lsp::lsp_types::Range::new(
        protocol_byte_offset(text, range.start, encoding)?,
        protocol_byte_offset(text, range.end, encoding)?,
    ))
}

fn protocol_byte_offset(
    text: &str,
    offset: usize,
    encoding: &PositionEncodingKind,
) -> Option<ash_lsp::lsp_types::Position> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return None;
    }
    let prefix = &text[..offset];
    let row = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
    let line_prefix = &text[line_start..offset];
    let character = if *encoding == PositionEncodingKind::UTF8 {
        line_prefix.len()
    } else {
        line_prefix.encode_utf16().count()
    };
    Some(ash_lsp::lsp_types::Position::new(
        u32::try_from(row).ok()?,
        u32::try_from(character).ok()?,
    ))
}

impl Supervisor {
    pub(super) fn begin_workspace_symbols(
        &mut self,
        id: LanguageRequestId,
        language_id: String,
        query: String,
    ) {
        let Some((server, server_epoch)) = self.server_for_language(&language_id) else {
            self.record_rejected_request(LanguageRequestKind::WorkspaceSymbols);
            self.emit_request_result(LspManagerRequestResult::WorkspaceSymbols(LanguageSymbols {
                request_id: id,
                query,
                symbols: Vec::new(),
            }));
            return;
        };
        let Ok(client) = self.router.client_for_language(&language_id).cloned() else {
            self.record_rejected_request(LanguageRequestKind::WorkspaceSymbols);
            self.emit_request_result(LspManagerRequestResult::WorkspaceSymbols(LanguageSymbols {
                request_id: id,
                query,
                symbols: Vec::new(),
            }));
            return;
        };
        if !matches!(
            client
                .initialization()
                .capabilities
                .workspace_symbol_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ) {
            self.record_rejected_request(LanguageRequestKind::WorkspaceSymbols);
            self.emit_request_result(LspManagerRequestResult::WorkspaceSymbols(LanguageSymbols {
                request_id: id,
                query,
                symbols: Vec::new(),
            }));
            return;
        }
        let encoding = client.initialization().position_encoding.clone();
        let generation = self.generation;
        let commands = self.commands.clone();
        let completion_query = query.clone();
        let kind = LanguageRequestKind::WorkspaceSymbols;
        let cold_for_incarnation =
            self.observed_request_kinds
                .insert((server.clone(), server_epoch, kind));
        let started = Instant::now();
        let completion_server = server.clone();
        let cancellation = ash_async_utils::CancellationSource::new();
        let cancellation_token = cancellation.token();
        let _ = tokio::spawn(async move {
            let client = CancellableLanguageServerClient::new(client, cancellation_token);
            let result = client
                .request::<WorkspaceSymbolRequest>(WorkspaceSymbolParams {
                    query: query.clone(),
                    partial_result_params: PartialResultParams::default(),
                    work_done_progress_params: WorkDoneProgressParams::default(),
                })
                .await
                .map(|response| project_workspace_symbols(id, query, &encoding, response))
                .map_err(|error| error.to_string());
            let _ = commands.send(SupervisorCommand::WorkspaceSymbolsCompleted {
                id,
                query: completion_query,
                server: completion_server,
                generation,
                server_epoch,
                result,
            });
        });
        self.in_flight_requests.insert(
            id,
            InFlightLanguageRequest {
                cancellation,
                kind,
                server,
                server_epoch,
                configuration_generation: self.configuration.generation,
                service_generation: generation,
                cold_for_incarnation,
                started,
            },
        );
    }

    pub(super) fn complete_workspace_symbols(
        &mut self,
        id: LanguageRequestId,
        query: String,
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<LanguageSymbols, String>,
    ) {
        let Some(tracking) = self.in_flight_requests.remove(&id) else {
            return;
        };
        if tracking.cancellation.token().is_cancelled() {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
            return;
        }
        if generation != self.generation
            || !self.servers.get(&server).is_some_and(|managed| {
                managed.epoch == server_epoch && managed.phase == ManagedServerPhase::Ready
            })
        {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::StaleDiscarded, 0);
            return;
        }
        match result {
            Ok(result) => {
                let result_count = result.symbols.len();
                self.record_request_metric(
                    tracking,
                    LanguageRequestMetricOutcome::Delivered,
                    result_count,
                );
                self.emit_request_result(LspManagerRequestResult::WorkspaceSymbols(result));
            }
            Err(message) => {
                self.record_request_metric(tracking, LanguageRequestMetricOutcome::Failed, 0);
                self.emit_notification(LspManagerNotification::ServerMessage {
                    server: server.to_string(),
                    severity: LanguageServerMessageSeverity::Error,
                    source: super::LanguageServerMessageSource::Service,
                    show: false,
                    message,
                });
                self.emit_request_result(LspManagerRequestResult::WorkspaceSymbols(
                    LanguageSymbols {
                        request_id: id,
                        query,
                        symbols: Vec::new(),
                    },
                ));
            }
        }
    }
}

fn text_document_position(
    uri: Uri,
    position: Option<ash_lsp::lsp_types::Position>,
) -> Result<TextDocumentPositionParams, String> {
    Ok(TextDocumentPositionParams::new(
        TextDocumentIdentifier::new(uri),
        position.ok_or_else(|| "language request requires a document position".to_owned())?,
    ))
}

fn hierarchy_result(
    result: LanguageHierarchyResult,
    id: LanguageRequestId,
    kind: LanguageRequestKind,
    path: PathBuf,
    revision: LanguageDocumentRevision,
) -> Result<CompletedLanguageRequest, String> {
    if result.entries.is_empty() {
        Ok(CompletedLanguageRequest::Empty {
            id,
            kind,
            path,
            revision,
        })
    } else {
        Ok(CompletedLanguageRequest::Hierarchy(result))
    }
}

async fn execute_locations<R>(
    client: CancellableLanguageServerClient,
    text_document_position_params: TextDocumentPositionParams,
    id: LanguageRequestId,
    request_kind: LanguageRequestKind,
    location_kind: LanguageLocationKind,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    encoding: PositionEncodingKind,
) -> Result<CompletedLanguageRequest, String>
where
    R: ash_lsp::lsp_types::request::Request<
            Params = GotoDefinitionParams,
            Result = Option<ash_lsp::lsp_types::GotoDefinitionResponse>,
        >,
{
    let response = client
        .request::<R>(GotoDefinitionParams {
            text_document_position_params,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        })
        .await
        .map_err(|error| error.to_string())?;
    let result = project_locations(
        id,
        location_kind,
        path.clone(),
        revision,
        &encoding,
        response,
    );
    if result.targets.is_empty() {
        Ok(CompletedLanguageRequest::Empty {
            id,
            kind: request_kind,
            path,
            revision,
        })
    } else {
        Ok(CompletedLanguageRequest::Locations(result))
    }
}

pub(super) fn capability_snapshot(
    client: &LanguageServerClient,
    incarnation: u64,
) -> LanguageServerCapabilities {
    let candidates = [
        (LanguageServerFeature::Hover, LanguageRequestKind::Hover),
        (
            LanguageServerFeature::Completion,
            LanguageRequestKind::Completion,
        ),
        (
            LanguageServerFeature::Declaration,
            LanguageRequestKind::Declaration,
        ),
        (
            LanguageServerFeature::Definition,
            LanguageRequestKind::Definition,
        ),
        (
            LanguageServerFeature::Implementation,
            LanguageRequestKind::Implementation,
        ),
        (
            LanguageServerFeature::TypeDefinition,
            LanguageRequestKind::TypeDefinition,
        ),
        (
            LanguageServerFeature::References,
            LanguageRequestKind::References,
        ),
        (
            LanguageServerFeature::CallHierarchy,
            LanguageRequestKind::PrepareCallHierarchy,
        ),
        (
            LanguageServerFeature::TypeHierarchy,
            LanguageRequestKind::PrepareTypeHierarchy,
        ),
        (
            LanguageServerFeature::WorkspaceSymbols,
            LanguageRequestKind::WorkspaceSymbols,
        ),
        (LanguageServerFeature::Rename, LanguageRequestKind::Rename),
        (
            LanguageServerFeature::CodeActions,
            LanguageRequestKind::CodeActions,
        ),
        (
            LanguageServerFeature::DocumentFormatting,
            LanguageRequestKind::DocumentFormatting,
        ),
        (
            LanguageServerFeature::RangeFormatting,
            LanguageRequestKind::RangeFormatting,
        ),
        (
            LanguageServerFeature::SignatureHelp,
            LanguageRequestKind::SignatureHelp,
        ),
        (
            LanguageServerFeature::InlayHints,
            LanguageRequestKind::InlayHints,
        ),
        (
            LanguageServerFeature::LinkedEditingRanges,
            LanguageRequestKind::LinkedEditingRanges,
        ),
        (
            LanguageServerFeature::SemanticTokens,
            LanguageRequestKind::SemanticTokens,
        ),
        (
            LanguageServerFeature::DocumentSymbols,
            LanguageRequestKind::DocumentSymbols,
        ),
        (
            LanguageServerFeature::CodeLens,
            LanguageRequestKind::CodeLenses,
        ),
        (
            LanguageServerFeature::DocumentLinks,
            LanguageRequestKind::DocumentLinks,
        ),
        (
            LanguageServerFeature::DocumentColors,
            LanguageRequestKind::DocumentColors,
        ),
        (
            LanguageServerFeature::FoldingRanges,
            LanguageRequestKind::FoldingRanges,
        ),
        (
            LanguageServerFeature::PullDiagnostics,
            LanguageRequestKind::DocumentDiagnostics,
        ),
        (
            LanguageServerFeature::WorkspaceDiagnostics,
            LanguageRequestKind::WorkspaceDiagnostics,
        ),
    ];
    let features = candidates
        .into_iter()
        .filter_map(|(feature, kind)| supports_request(client, kind).then_some(feature))
        .collect();
    LanguageServerCapabilities {
        incarnation,
        dynamic_revision: client.dynamic_capabilities().revision,
        features,
    }
}

pub(super) fn supports_request(client: &LanguageServerClient, kind: LanguageRequestKind) -> bool {
    if dynamically_supports_request(client, kind) {
        return true;
    }
    let capabilities = &client.initialization().capabilities;
    match kind {
        LanguageRequestKind::Hover => matches!(
            capabilities.hover_provider,
            Some(ash_lsp::lsp_types::HoverProviderCapability::Simple(true))
                | Some(ash_lsp::lsp_types::HoverProviderCapability::Options(_))
        ),
        LanguageRequestKind::Completion => capabilities.completion_provider.is_some(),
        LanguageRequestKind::ResolveCompletion => capabilities
            .completion_provider
            .as_ref()
            .is_some_and(|options| options.resolve_provider == Some(true)),
        LanguageRequestKind::ExecuteCommand => capabilities.execute_command_provider.is_some(),
        LanguageRequestKind::Definition => matches!(
            capabilities.definition_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::Declaration => matches!(
            capabilities.declaration_provider,
            Some(DeclarationCapability::Simple(true))
                | Some(DeclarationCapability::RegistrationOptions(_))
                | Some(DeclarationCapability::Options(_))
        ),
        LanguageRequestKind::Implementation => matches!(
            capabilities.implementation_provider,
            Some(ImplementationProviderCapability::Simple(true))
                | Some(ImplementationProviderCapability::Options(_))
        ),
        LanguageRequestKind::TypeDefinition => matches!(
            capabilities.type_definition_provider,
            Some(TypeDefinitionProviderCapability::Simple(true))
                | Some(TypeDefinitionProviderCapability::Options(_))
        ),
        LanguageRequestKind::References => matches!(
            capabilities.references_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::PrepareCallHierarchy
        | LanguageRequestKind::IncomingCalls
        | LanguageRequestKind::OutgoingCalls => matches!(
            capabilities.call_hierarchy_provider,
            Some(CallHierarchyServerCapability::Simple(true))
                | Some(CallHierarchyServerCapability::Options(_))
        ),
        LanguageRequestKind::PrepareTypeHierarchy
        | LanguageRequestKind::Supertypes
        | LanguageRequestKind::Subtypes => true,
        LanguageRequestKind::WorkspaceSymbols => matches!(
            capabilities.workspace_symbol_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::PrepareRename | LanguageRequestKind::Rename => matches!(
            capabilities.rename_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::CodeActions => matches!(
            capabilities.code_action_provider,
            Some(CodeActionProviderCapability::Simple(true))
                | Some(CodeActionProviderCapability::Options(_))
        ),
        LanguageRequestKind::ResolveCodeAction => matches!(
            capabilities.code_action_provider,
            Some(CodeActionProviderCapability::Options(ref options)) if options.resolve_provider == Some(true)
        ),
        LanguageRequestKind::DocumentFormatting => matches!(
            capabilities.document_formatting_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::RangeFormatting => matches!(
            capabilities.document_range_formatting_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::SignatureHelp => capabilities.signature_help_provider.is_some(),
        LanguageRequestKind::InlayHints => matches!(
            capabilities.inlay_hint_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::LinkedEditingRanges => matches!(
            capabilities.linked_editing_range_provider,
            Some(LinkedEditingRangeServerCapabilities::Simple(true))
                | Some(LinkedEditingRangeServerCapabilities::Options(_))
                | Some(LinkedEditingRangeServerCapabilities::RegistrationOptions(_))
        ),
        LanguageRequestKind::SemanticTokens => {
            semantic_tokens_options(client).is_some_and(|options| {
                matches!(
                    options.full,
                    Some(SemanticTokensFullOptions::Bool(true))
                        | Some(SemanticTokensFullOptions::Delta { .. })
                )
            })
        }
        LanguageRequestKind::DocumentSymbols => matches!(
            capabilities.document_symbol_provider,
            Some(OneOf::Left(true)) | Some(OneOf::Right(_))
        ),
        LanguageRequestKind::CodeLenses => capabilities.code_lens_provider.is_some(),
        LanguageRequestKind::ResolveCodeLens => capabilities
            .code_lens_provider
            .as_ref()
            .is_some_and(|options| options.resolve_provider == Some(true)),
        LanguageRequestKind::DocumentLinks => capabilities.document_link_provider.is_some(),
        LanguageRequestKind::ResolveDocumentLink => capabilities
            .document_link_provider
            .as_ref()
            .is_some_and(|options| options.resolve_provider == Some(true)),
        LanguageRequestKind::DocumentColors | LanguageRequestKind::ColorPresentations => matches!(
            capabilities.color_provider.as_ref(),
            Some(ColorProviderCapability::Simple(true))
                | Some(ColorProviderCapability::ColorProvider(_))
                | Some(ColorProviderCapability::Options(_))
        ),
        LanguageRequestKind::FoldingRanges => matches!(
            capabilities.folding_range_provider.as_ref(),
            Some(FoldingRangeProviderCapability::Simple(true))
                | Some(FoldingRangeProviderCapability::FoldingProvider(_))
                | Some(FoldingRangeProviderCapability::Options(_))
        ),
        LanguageRequestKind::DocumentDiagnostics => capabilities.diagnostic_provider.is_some(),
        LanguageRequestKind::WorkspaceDiagnostics => capabilities
            .diagnostic_provider
            .as_ref()
            .is_some_and(workspace_diagnostics_supported),
    }
}

fn dynamically_supports_request(client: &LanguageServerClient, kind: LanguageRequestKind) -> bool {
    let method = match kind {
        LanguageRequestKind::Hover => "textDocument/hover",
        LanguageRequestKind::Completion => "textDocument/completion",
        LanguageRequestKind::ResolveCompletion => {
            return dynamic_resolve_provider(client, "textDocument/completion");
        }
        LanguageRequestKind::ExecuteCommand => "workspace/executeCommand",
        LanguageRequestKind::Declaration => "textDocument/declaration",
        LanguageRequestKind::Definition => "textDocument/definition",
        LanguageRequestKind::Implementation => "textDocument/implementation",
        LanguageRequestKind::TypeDefinition => "textDocument/typeDefinition",
        LanguageRequestKind::References => "textDocument/references",
        LanguageRequestKind::PrepareCallHierarchy
        | LanguageRequestKind::IncomingCalls
        | LanguageRequestKind::OutgoingCalls => "textDocument/prepareCallHierarchy",
        LanguageRequestKind::PrepareTypeHierarchy
        | LanguageRequestKind::Supertypes
        | LanguageRequestKind::Subtypes => "textDocument/prepareTypeHierarchy",
        LanguageRequestKind::WorkspaceSymbols => "workspace/symbol",
        LanguageRequestKind::PrepareRename | LanguageRequestKind::Rename => "textDocument/rename",
        LanguageRequestKind::CodeActions => "textDocument/codeAction",
        LanguageRequestKind::ResolveCodeAction => {
            return client
                .dynamic_capabilities()
                .registrations
                .iter()
                .any(|registration| {
                    registration.method == "textDocument/codeAction"
                        && registration
                            .register_options
                            .as_ref()
                            .and_then(|options| options.get("resolveProvider"))
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                });
        }
        LanguageRequestKind::DocumentFormatting => "textDocument/formatting",
        LanguageRequestKind::RangeFormatting => "textDocument/rangeFormatting",
        LanguageRequestKind::SignatureHelp => "textDocument/signatureHelp",
        LanguageRequestKind::InlayHints => "textDocument/inlayHint",
        LanguageRequestKind::LinkedEditingRanges => "textDocument/linkedEditingRange",
        LanguageRequestKind::SemanticTokens => {
            return semantic_tokens_options(client).is_some_and(|options| {
                matches!(
                    options.full,
                    Some(SemanticTokensFullOptions::Bool(true))
                        | Some(SemanticTokensFullOptions::Delta { .. })
                )
            });
        }
        LanguageRequestKind::DocumentSymbols => "textDocument/documentSymbol",
        LanguageRequestKind::CodeLenses => "textDocument/codeLens",
        LanguageRequestKind::ResolveCodeLens => {
            return dynamic_resolve_provider(client, "textDocument/codeLens");
        }
        LanguageRequestKind::DocumentLinks => "textDocument/documentLink",
        LanguageRequestKind::ResolveDocumentLink => {
            return dynamic_resolve_provider(client, "textDocument/documentLink");
        }
        LanguageRequestKind::DocumentColors | LanguageRequestKind::ColorPresentations => {
            "textDocument/documentColor"
        }
        LanguageRequestKind::FoldingRanges => "textDocument/foldingRange",
        LanguageRequestKind::DocumentDiagnostics => "textDocument/diagnostic",
        LanguageRequestKind::WorkspaceDiagnostics => {
            return client
                .dynamic_capabilities()
                .registrations
                .iter()
                .any(|registration| {
                    registration.method == "textDocument/diagnostic"
                        && registration
                            .register_options
                            .as_ref()
                            .and_then(|options| options.get("workspaceDiagnostics"))
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                });
        }
    };
    client.supports_dynamic_method(method)
}

pub(super) fn workspace_diagnostics_supported(
    capabilities: &ash_lsp::lsp_types::DiagnosticServerCapabilities,
) -> bool {
    match capabilities {
        ash_lsp::lsp_types::DiagnosticServerCapabilities::Options(options) => {
            options.workspace_diagnostics
        }
        ash_lsp::lsp_types::DiagnosticServerCapabilities::RegistrationOptions(options) => {
            options.diagnostic_options.workspace_diagnostics
        }
    }
}

fn dynamic_resolve_provider(client: &LanguageServerClient, method: &str) -> bool {
    client
        .dynamic_capabilities()
        .registrations
        .iter()
        .any(|registration| {
            registration.method == method
                && registration
                    .register_options
                    .as_ref()
                    .and_then(|options| options.get("resolveProvider"))
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
        })
}

fn supports_command(client: &LanguageServerClient, command: &str) -> bool {
    client
        .initialization()
        .capabilities
        .execute_command_provider
        .as_ref()
        .is_some_and(|provider| {
            provider
                .commands
                .iter()
                .any(|candidate| candidate == command)
        })
        || client
            .dynamic_capabilities()
            .registrations
            .iter()
            .filter(|registration| registration.method == "workspace/executeCommand")
            .filter_map(|registration| registration.register_options.as_ref())
            .filter_map(|options| options.get("commands"))
            .filter_map(serde_json::Value::as_array)
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .any(|candidate| candidate == command)
}
