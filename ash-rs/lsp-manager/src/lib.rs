//! Product-level LSP coordination above the protocol-only `ash-lsp` runtime.
//!
//! This crate owns enablement, resolved server definition consumption, document snapshot routing,
//! diagnostic freshness, position conversion, and manager-thread lifecycle. It does not own
//! editor text, filesystem access, UI presentation, executable discovery, installation, or verification.

mod capabilities;
mod configuration;
mod diagnostics;
mod document;
mod document_features;
mod error;
mod manager;
mod metrics;
mod projection;
mod requests;
mod restart;
mod semantic_tokens;
mod workspace_diagnostics;

pub use ash_lsp_server_provider::LanguageServerDefinition;
pub use capabilities::{LanguageServerCapabilities, LanguageServerFeature};
pub use configuration::{LspManagerConfiguration, LspManagerEnablement};
pub use diagnostics::{
    LanguageDiagnostic, LanguageDiagnosticSeverity, LanguageDiagnostics, LanguageTextRange,
};
pub use document::{LanguageDocumentRevision, LspDocumentSnapshot};
pub use document_features::{
    LanguageCodeLens, LanguageCodeLenses, LanguageColor, LanguageColorPresentation,
    LanguageColorPresentations, LanguageCommand, LanguageDocumentColor, LanguageDocumentColors,
    LanguageDocumentLink, LanguageDocumentLinks, LanguageDocumentSymbol, LanguageDocumentSymbols,
    LanguageFoldingRange, LanguageFoldingRangeKind, LanguageFoldingRanges,
};
pub use error::LspManagerError;
pub use manager::{
    LanguageServerMessageSeverity, LanguageServerMessageSource, LanguageServerProgress,
    LanguageServerState, LanguageServiceEvent, LanguageServiceEventSink, LspDocumentOperation,
    LspManager, LspManagerEvent, LspManagerEventSink, LspManagerNotification,
    LspManagerRequestResult, NoopLanguageServiceEventSink, NoopLspManagerEventSink,
};
pub use metrics::LanguageRequestMetric;
pub use metrics::LanguageRequestMetricOutcome;
pub use metrics::LspRequestMetricsSink;
pub use metrics::LspRequestMetricsSink as LanguageServiceMetricsSink;
pub use requests::{
    LanguageCodeAction, LanguageCodeActions, LanguageCommandResult, LanguageCompletionDetails,
    LanguageCompletionInsertTextFormat, LanguageCompletionItem, LanguageCompletionItemKind,
    LanguageCompletionTrigger, LanguageCompletions, LanguageDeleteMode, LanguageDocumentPosition,
    LanguageEdit, LanguageEditEntry, LanguageEditResult, LanguageExistingTargetBehavior,
    LanguageFormattingEdits, LanguageFormattingOptions, LanguageHierarchyEntry,
    LanguageHierarchyItem, LanguageHierarchyKind, LanguageHierarchyResult, LanguageHover,
    LanguageInlayHint, LanguageInlayHintKind, LanguageInlayHints, LanguageLinkedEditingRanges,
    LanguageLocationKind, LanguageLocationPosition, LanguageLocationRange, LanguageLocationTarget,
    LanguageLocations, LanguageMissingTargetBehavior, LanguageParameterInformation,
    LanguagePositionEncoding, LanguagePulledDiagnosticReport, LanguagePulledDiagnostics,
    LanguageRenamePreparation, LanguageRequestId, LanguageRequestKind, LanguageSignatureHelp,
    LanguageSignatureHelpTrigger, LanguageSignatureInformation, LanguageSymbol, LanguageSymbols,
    LanguageTextEdit, LanguageWorkspaceDocumentEdit, LanguageWorkspaceTextEdit,
};
pub use restart::LanguageServerRestartPolicy;
pub use semantic_tokens::{LanguageSemanticToken, LanguageSemanticTokens};
pub use workspace_diagnostics::{LanguageDirectoryDiagnostic, LanguageDirectoryDiagnostics};

/// Compatibility name for the pre-LSP manager configuration.
pub type LanguageServiceConfiguration = LspManagerConfiguration;

/// Compatibility name for the pre-LSP manager enablement policy.
pub type LanguageServiceEnablement = LspManagerEnablement;

/// Compatibility name for the pre-LSP document snapshot.
pub type LanguageServiceDocument = LspDocumentSnapshot;

/// Compatibility name for the pre-LSP manager error.
pub type LanguageServiceError = LspManagerError;

/// Compatibility name for the pre-LSP document operation.
pub type LanguageServiceDocumentOperation = LspDocumentOperation;

/// Compatibility name for the pre-LSP manager.
pub type LanguageService = LspManager;
