use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc as std_mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ash_async_utils::CancellationSource;
use ash_lsp::lsp_types::{
    MessageType, NumberOrString, ProgressParamsValue, PublishDiagnosticsParams, Uri,
    WorkDoneProgress,
};
use ash_lsp::{
    EditorDocumentRevision, LanguageDocumentSnapshot, LanguageServerClient,
    LanguageServerDocumentRouter, LanguageServerEvent, LanguageServerHost, LanguageServerName,
    LanguageServerOptions, LanguageServerRoute,
};
use tokio::sync::mpsc;

use crate::LanguageRequestMetric;
use crate::LanguageRequestMetricOutcome;
use crate::LspRequestMetricsSink;
use crate::projection::project_diagnostic;
use crate::restart::{RestartDecision, ServerRestartTracker};
use crate::{
    LanguageCodeActions, LanguageCodeLens, LanguageCodeLenses, LanguageColor,
    LanguageColorPresentations, LanguageCommand, LanguageCommandResult, LanguageCompletionDetails,
    LanguageCompletionTrigger, LanguageCompletions, LanguageDiagnostic, LanguageDiagnostics,
    LanguageDirectoryDiagnostics, LanguageDocumentColors, LanguageDocumentLink,
    LanguageDocumentLinks, LanguageDocumentPosition, LanguageDocumentRevision,
    LanguageDocumentSymbols, LanguageEditResult, LanguageFoldingRanges, LanguageFormattingEdits,
    LanguageFormattingOptions, LanguageHierarchyItem, LanguageHierarchyResult, LanguageHover,
    LanguageInlayHints, LanguageLinkedEditingRanges, LanguageLocationRange, LanguageLocations,
    LanguagePulledDiagnostics, LanguageRenamePreparation, LanguageRequestId, LanguageRequestKind,
    LanguageSemanticTokens, LanguageServerCapabilities, LanguageServerDefinition,
    LanguageSignatureHelp, LanguageSignatureHelpTrigger, LanguageSymbols, LanguageTextRange,
    LspDocumentSnapshot, LspManagerConfiguration, LspManagerEnablement, LspManagerError,
};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

mod lifecycle;
mod request_runtime;
mod workspace_diagnostic_request;

use request_runtime::{CompletedLanguageRequest, PendingLanguageRequest};

/// Product-visible lifecycle state of one configured language server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageServerState {
    Starting,
    Ready,
    BackingOff {
        attempt: u32,
        retry_after: Duration,
    },
    CrashLoop {
        restart_attempts: u32,
        message: String,
    },
    Failed(String),
    Stopped,
}

/// Document operation that failed after crossing the asynchronous service boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspDocumentOperation {
    Synchronize,
    Save,
    Close,
}

/// Presentation-neutral severity for a language-server message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageServerMessageSeverity {
    Error,
    Warning,
    Information,
    Log,
}

/// Origin of a product-visible language-server message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageServerMessageSource {
    Protocol,
    Stderr,
    Service,
}

/// Product-visible work-done progress state for one server-owned token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerProgress {
    pub server: String,
    pub token: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub percentage: Option<u32>,
    pub done: bool,
}

/// Push notifications produced by a server or by manager lifecycle transitions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspManagerNotification {
    ServerStateChanged {
        server: String,
        state: LanguageServerState,
    },
    Diagnostics(LanguageDiagnostics),
    ServerMessage {
        server: String,
        severity: LanguageServerMessageSeverity,
        source: LanguageServerMessageSource,
        show: bool,
        message: String,
    },
    ServerProgress(LanguageServerProgress),
    CapabilitiesChanged {
        server: String,
        capabilities: LanguageServerCapabilities,
    },
    DocumentOperationFailed {
        path: PathBuf,
        operation: LspDocumentOperation,
        message: String,
    },
}

/// Result of one request issued through the manager.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspManagerRequestResult {
    PulledDiagnostics(LanguagePulledDiagnostics),
    Hover(LanguageHover),
    Completions(LanguageCompletions),
    CompletionDetails(LanguageCompletionDetails),
    CommandResult(LanguageCommandResult),
    Locations(LanguageLocations),
    Hierarchy(LanguageHierarchyResult),
    WorkspaceSymbols(LanguageSymbols),
    DirectoryDiagnostics(LanguageDirectoryDiagnostics),
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
    RequestFailed {
        request_id: LanguageRequestId,
        kind: LanguageRequestKind,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        message: String,
    },
}

impl LspManagerRequestResult {
    /// Returns the request identity shared by every result variant.
    pub const fn request_id(&self) -> LanguageRequestId {
        match self {
            Self::PulledDiagnostics(result) => result.request_id,
            Self::Hover(result) => result.request_id,
            Self::Completions(result) => result.request_id,
            Self::CompletionDetails(result) => result.request_id,
            Self::CommandResult(result) => result.request_id,
            Self::Locations(result) => result.request_id,
            Self::Hierarchy(result) => result.request_id,
            Self::WorkspaceSymbols(result) => result.request_id,
            Self::DirectoryDiagnostics(result) => result.request_id,
            Self::RenamePreparation(result) => result.request_id,
            Self::WorkspaceEdit(result) => result.request_id,
            Self::CodeActions(result) => result.request_id,
            Self::FormattingEdits(result) => result.request_id,
            Self::SignatureHelp(result) => result.request_id,
            Self::InlayHints(result) => result.request_id,
            Self::LinkedEditingRanges(result) => result.request_id,
            Self::SemanticTokens(result) => result.request_id,
            Self::DocumentSymbols(result) => result.request_id,
            Self::CodeLenses(result) => result.request_id,
            Self::DocumentLinks(result) => result.request_id,
            Self::DocumentColors(result) => result.request_id,
            Self::ColorPresentations(result) => result.request_id,
            Self::FoldingRanges(result) => result.request_id,
            Self::RequestFailed { request_id, .. } => *request_id,
        }
    }
}

/// Product-level events emitted after protocol details and stale results have been resolved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspManagerEvent {
    Notification(LspManagerNotification),
    RequestResult(LspManagerRequestResult),
}

/// Compatibility event shape for the old App integration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanguageServiceEvent {
    ServerStateChanged {
        server: String,
        state: LanguageServerState,
    },
    Diagnostics(LanguageDiagnostics),
    PulledDiagnostics(LanguagePulledDiagnostics),
    ServerMessage {
        server: String,
        severity: LanguageServerMessageSeverity,
        source: LanguageServerMessageSource,
        show: bool,
        message: String,
    },
    ServerProgress(LanguageServerProgress),
    CapabilitiesChanged {
        server: String,
        capabilities: LanguageServerCapabilities,
    },
    DocumentOperationFailed {
        path: PathBuf,
        operation: LspDocumentOperation,
        message: String,
    },
    Hover(LanguageHover),
    Completions(LanguageCompletions),
    CompletionDetails(LanguageCompletionDetails),
    CommandResult(LanguageCommandResult),
    Locations(LanguageLocations),
    Hierarchy(LanguageHierarchyResult),
    WorkspaceSymbols(LanguageSymbols),
    DirectoryDiagnostics(LanguageDirectoryDiagnostics),
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
    RequestFailed {
        request_id: LanguageRequestId,
        kind: LanguageRequestKind,
        path: PathBuf,
        revision: LanguageDocumentRevision,
        message: String,
    },
}

impl From<LspManagerEvent> for LanguageServiceEvent {
    fn from(event: LspManagerEvent) -> Self {
        match event {
            LspManagerEvent::Notification(notification) => match notification {
                LspManagerNotification::ServerStateChanged { server, state } => {
                    Self::ServerStateChanged { server, state }
                }
                LspManagerNotification::Diagnostics(diagnostics) => Self::Diagnostics(diagnostics),
                LspManagerNotification::ServerMessage {
                    server,
                    severity,
                    source,
                    show,
                    message,
                } => Self::ServerMessage {
                    server,
                    severity,
                    source,
                    show,
                    message,
                },
                LspManagerNotification::ServerProgress(progress) => Self::ServerProgress(progress),
                LspManagerNotification::CapabilitiesChanged {
                    server,
                    capabilities,
                } => Self::CapabilitiesChanged {
                    server,
                    capabilities,
                },
                LspManagerNotification::DocumentOperationFailed {
                    path,
                    operation,
                    message,
                } => Self::DocumentOperationFailed {
                    path,
                    operation,
                    message,
                },
            },
            LspManagerEvent::RequestResult(result) => match result {
                LspManagerRequestResult::PulledDiagnostics(result) => {
                    Self::PulledDiagnostics(result)
                }
                LspManagerRequestResult::Hover(result) => Self::Hover(result),
                LspManagerRequestResult::Completions(result) => Self::Completions(result),
                LspManagerRequestResult::CompletionDetails(result) => {
                    Self::CompletionDetails(result)
                }
                LspManagerRequestResult::CommandResult(result) => Self::CommandResult(result),
                LspManagerRequestResult::Locations(result) => Self::Locations(result),
                LspManagerRequestResult::Hierarchy(result) => Self::Hierarchy(result),
                LspManagerRequestResult::WorkspaceSymbols(result) => Self::WorkspaceSymbols(result),
                LspManagerRequestResult::DirectoryDiagnostics(result) => {
                    Self::DirectoryDiagnostics(result)
                }
                LspManagerRequestResult::RenamePreparation(result) => {
                    Self::RenamePreparation(result)
                }
                LspManagerRequestResult::WorkspaceEdit(result) => Self::WorkspaceEdit(result),
                LspManagerRequestResult::CodeActions(result) => Self::CodeActions(result),
                LspManagerRequestResult::FormattingEdits(result) => Self::FormattingEdits(result),
                LspManagerRequestResult::SignatureHelp(result) => Self::SignatureHelp(result),
                LspManagerRequestResult::InlayHints(result) => Self::InlayHints(result),
                LspManagerRequestResult::LinkedEditingRanges(result) => {
                    Self::LinkedEditingRanges(result)
                }
                LspManagerRequestResult::SemanticTokens(result) => Self::SemanticTokens(result),
                LspManagerRequestResult::DocumentSymbols(result) => Self::DocumentSymbols(result),
                LspManagerRequestResult::CodeLenses(result) => Self::CodeLenses(result),
                LspManagerRequestResult::DocumentLinks(result) => Self::DocumentLinks(result),
                LspManagerRequestResult::DocumentColors(result) => Self::DocumentColors(result),
                LspManagerRequestResult::ColorPresentations(result) => {
                    Self::ColorPresentations(result)
                }
                LspManagerRequestResult::FoldingRanges(result) => Self::FoldingRanges(result),
                LspManagerRequestResult::RequestFailed {
                    request_id,
                    kind,
                    path,
                    revision,
                    message,
                } => Self::RequestFailed {
                    request_id,
                    kind,
                    path,
                    revision,
                    message,
                },
            },
        }
    }
}

impl From<LanguageServiceEvent> for LspManagerEvent {
    fn from(event: LanguageServiceEvent) -> Self {
        match event {
            LanguageServiceEvent::ServerStateChanged { server, state } => {
                Self::Notification(LspManagerNotification::ServerStateChanged { server, state })
            }
            LanguageServiceEvent::Diagnostics(diagnostics) => {
                Self::Notification(LspManagerNotification::Diagnostics(diagnostics))
            }
            LanguageServiceEvent::PulledDiagnostics(result) => {
                Self::RequestResult(LspManagerRequestResult::PulledDiagnostics(result))
            }
            LanguageServiceEvent::ServerMessage {
                server,
                severity,
                source,
                show,
                message,
            } => Self::Notification(LspManagerNotification::ServerMessage {
                server,
                severity,
                source,
                show,
                message,
            }),
            LanguageServiceEvent::ServerProgress(progress) => {
                Self::Notification(LspManagerNotification::ServerProgress(progress))
            }
            LanguageServiceEvent::CapabilitiesChanged {
                server,
                capabilities,
            } => Self::Notification(LspManagerNotification::CapabilitiesChanged {
                server,
                capabilities,
            }),
            LanguageServiceEvent::DocumentOperationFailed {
                path,
                operation,
                message,
            } => Self::Notification(LspManagerNotification::DocumentOperationFailed {
                path,
                operation,
                message,
            }),
            LanguageServiceEvent::Hover(result) => {
                Self::RequestResult(LspManagerRequestResult::Hover(result))
            }
            LanguageServiceEvent::Completions(result) => {
                Self::RequestResult(LspManagerRequestResult::Completions(result))
            }
            LanguageServiceEvent::CompletionDetails(result) => {
                Self::RequestResult(LspManagerRequestResult::CompletionDetails(result))
            }
            LanguageServiceEvent::CommandResult(result) => {
                Self::RequestResult(LspManagerRequestResult::CommandResult(result))
            }
            LanguageServiceEvent::Locations(result) => {
                Self::RequestResult(LspManagerRequestResult::Locations(result))
            }
            LanguageServiceEvent::Hierarchy(result) => {
                Self::RequestResult(LspManagerRequestResult::Hierarchy(result))
            }
            LanguageServiceEvent::WorkspaceSymbols(result) => {
                Self::RequestResult(LspManagerRequestResult::WorkspaceSymbols(result))
            }
            LanguageServiceEvent::DirectoryDiagnostics(result) => {
                Self::RequestResult(LspManagerRequestResult::DirectoryDiagnostics(result))
            }
            LanguageServiceEvent::RenamePreparation(result) => {
                Self::RequestResult(LspManagerRequestResult::RenamePreparation(result))
            }
            LanguageServiceEvent::WorkspaceEdit(result) => {
                Self::RequestResult(LspManagerRequestResult::WorkspaceEdit(result))
            }
            LanguageServiceEvent::CodeActions(result) => {
                Self::RequestResult(LspManagerRequestResult::CodeActions(result))
            }
            LanguageServiceEvent::FormattingEdits(result) => {
                Self::RequestResult(LspManagerRequestResult::FormattingEdits(result))
            }
            LanguageServiceEvent::SignatureHelp(result) => {
                Self::RequestResult(LspManagerRequestResult::SignatureHelp(result))
            }
            LanguageServiceEvent::InlayHints(result) => {
                Self::RequestResult(LspManagerRequestResult::InlayHints(result))
            }
            LanguageServiceEvent::LinkedEditingRanges(result) => {
                Self::RequestResult(LspManagerRequestResult::LinkedEditingRanges(result))
            }
            LanguageServiceEvent::SemanticTokens(result) => {
                Self::RequestResult(LspManagerRequestResult::SemanticTokens(result))
            }
            LanguageServiceEvent::DocumentSymbols(result) => {
                Self::RequestResult(LspManagerRequestResult::DocumentSymbols(result))
            }
            LanguageServiceEvent::CodeLenses(result) => {
                Self::RequestResult(LspManagerRequestResult::CodeLenses(result))
            }
            LanguageServiceEvent::DocumentLinks(result) => {
                Self::RequestResult(LspManagerRequestResult::DocumentLinks(result))
            }
            LanguageServiceEvent::DocumentColors(result) => {
                Self::RequestResult(LspManagerRequestResult::DocumentColors(result))
            }
            LanguageServiceEvent::ColorPresentations(result) => {
                Self::RequestResult(LspManagerRequestResult::ColorPresentations(result))
            }
            LanguageServiceEvent::FoldingRanges(result) => {
                Self::RequestResult(LspManagerRequestResult::FoldingRanges(result))
            }
            LanguageServiceEvent::RequestFailed {
                request_id,
                kind,
                path,
                revision,
                message,
            } => Self::RequestResult(LspManagerRequestResult::RequestFailed {
                request_id,
                kind,
                path,
                revision,
                message,
            }),
        }
    }
}

/// Non-blocking destination for the manager's typed event stream.
pub trait LspManagerEventSink: Send + Sync + 'static {
    fn on_event(&self, event: LspManagerEvent);
}

/// Non-blocking destination for the compatibility event stream used by the old App host.
///
/// Implementations are expected to enqueue the event into their UI or application event loop and
/// return immediately. They must not call blocking manager methods from this callback.
pub trait LanguageServiceEventSink: Send + Sync + 'static {
    fn on_event(&self, event: LanguageServiceEvent);
}

impl<T> LspManagerEventSink for T
where
    T: LanguageServiceEventSink,
{
    fn on_event(&self, event: LspManagerEvent) {
        LanguageServiceEventSink::on_event(self, event.into());
    }
}

struct LegacyEventSink {
    sink: Arc<dyn LanguageServiceEventSink>,
}

impl LspManagerEventSink for LegacyEventSink {
    fn on_event(&self, event: LspManagerEvent) {
        self.sink.on_event(event.into());
    }
}

/// Event sink used by hosts that intentionally ignore compatibility output.
#[derive(Debug, Default)]
pub struct NoopLanguageServiceEventSink;

impl LanguageServiceEventSink for NoopLanguageServiceEventSink {
    fn on_event(&self, _event: LanguageServiceEvent) {}
}

/// Event sink used by hosts that intentionally ignore manager output.
#[derive(Debug, Default)]
pub struct NoopLspManagerEventSink;

impl LspManagerEventSink for NoopLspManagerEventSink {
    fn on_event(&self, _event: LspManagerEvent) {}
}

/// Product-level language-service supervisor with a non-blocking document API.
///
/// The supervisor thread owns the Tokio runtime, `ash-lsp` clients, router, and document bindings.
/// Callers retain authoritative text and send full snapshots whenever their revision changes.
pub struct LspManager {
    commands: mpsc::UnboundedSender<SupervisorCommand>,
    thread: Option<JoinHandle<()>>,
    next_request_id: AtomicU64,
}

impl LspManager {
    pub fn start(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LanguageServiceEventSink>,
    ) -> Result<Self, LspManagerError> {
        Self::start_inner(
            configuration,
            Arc::new(LegacyEventSink { sink: events }),
            None,
        )
    }

    /// Starts the manager with the typed notification/request-result event stream.
    pub fn start_with_events(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LspManagerEventSink>,
    ) -> Result<Self, LspManagerError> {
        Self::start_inner(configuration, events, None)
    }

    /// Starts the service with content-free request metrics used to evaluate navigation caching.
    pub fn start_with_metrics(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LanguageServiceEventSink>,
        metrics: Arc<dyn LspRequestMetricsSink>,
    ) -> Result<Self, LspManagerError> {
        Self::start_inner(
            configuration,
            Arc::new(LegacyEventSink { sink: events }),
            Some(metrics),
        )
    }

    /// Starts the manager with typed events and content-free request metrics.
    pub fn start_with_events_and_metrics(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LspManagerEventSink>,
        metrics: Arc<dyn LspRequestMetricsSink>,
    ) -> Result<Self, LspManagerError> {
        Self::start_inner(configuration, events, Some(metrics))
    }

    fn start_inner(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LspManagerEventSink>,
        metrics: Option<Arc<dyn LspRequestMetricsSink>>,
    ) -> Result<Self, LspManagerError> {
        validate_definitions(&configuration)?;
        let (commands, receiver) = mpsc::unbounded_channel();
        let (started_tx, started_rx) = std_mpsc::sync_channel(1);
        let thread_commands = commands.clone();
        let thread = std::thread::Builder::new()
            .name("ash-lsp-manager".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .thread_name("ash-lsp-manager-worker")
                    .build();
                match runtime {
                    Ok(runtime) => {
                        let _ = started_tx.send(Ok(()));
                        runtime.block_on(
                            Supervisor::new(configuration, events, metrics, thread_commands)
                                .run(receiver),
                        );
                    }
                    Err(error) => {
                        let _ = started_tx.send(Err(error));
                    }
                }
            })
            .map_err(LspManagerError::RuntimeStart)?;
        match started_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                commands,
                thread: Some(thread),
                next_request_id: AtomicU64::new(1),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(LspManagerError::RuntimeStart(error))
            }
            Err(_) => {
                let _ = thread.join();
                Err(LspManagerError::Closed)
            }
        }
    }

    pub fn synchronize_document(
        &self,
        document: LspDocumentSnapshot,
    ) -> Result<(), LspManagerError> {
        self.send(SupervisorCommand::Synchronize(document))
    }

    pub fn save_document(&self, path: impl Into<PathBuf>) -> Result<(), LspManagerError> {
        self.send(SupervisorCommand::Save(path.into()))
    }

    pub fn close_document(&self, path: impl Into<PathBuf>) -> Result<(), LspManagerError> {
        self.send(SupervisorCommand::Close(path.into()))
    }

    pub fn set_enablement(&self, enablement: LspManagerEnablement) -> Result<(), LspManagerError> {
        self.send(SupervisorCommand::SetEnablement(enablement))
    }

    /// Cancels one queued or in-flight request. Unknown or already completed IDs are a no-op.
    pub fn cancel_request(&self, request_id: LanguageRequestId) -> Result<(), LspManagerError> {
        self.send(SupervisorCommand::CancelLanguageRequest(request_id))
    }

    pub fn request_hover(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Hover {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_completions(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        trigger: LanguageCompletionTrigger,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Completion {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
            trigger,
        })
    }

    pub fn request_resolve_completion(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        provider_data: serde_json::Value,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ResolveCompletion {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            provider_data,
        })
    }

    pub fn request_execute_command(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        command: LanguageCommand,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ExecuteCommand {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            command,
        })
    }

    pub fn request_definition(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Definition {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_declaration(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Declaration {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_implementation(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Implementation {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_type_definition(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::TypeDefinition {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_references(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        include_declaration: bool,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::References {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
            include_declaration,
        })
    }

    pub fn request_prepare_call_hierarchy(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::PrepareCallHierarchy {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_incoming_calls(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::IncomingCalls {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            item,
        })
    }

    pub fn request_outgoing_calls(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::OutgoingCalls {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            item,
        })
    }

    pub fn request_prepare_type_hierarchy(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::PrepareTypeHierarchy {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_supertypes(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Supertypes {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            item,
        })
    }

    pub fn request_subtypes(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        item: LanguageHierarchyItem,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Subtypes {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            item,
        })
    }

    pub fn request_workspace_symbols(
        &self,
        language_id: impl Into<String>,
        query: impl Into<String>,
    ) -> Result<LanguageRequestId, LspManagerError> {
        let id = self.next_request_id();
        self.send(SupervisorCommand::WorkspaceSymbols {
            id,
            language_id: language_id.into(),
            query: query.into(),
        })?;
        Ok(id)
    }

    pub fn request_workspace_diagnostics(
        &self,
        language_id: impl Into<String>,
    ) -> Result<LanguageRequestId, LspManagerError> {
        let id = self.next_request_id();
        self.send(SupervisorCommand::DirectoryDiagnostics {
            id,
            language_id: language_id.into(),
        })?;
        Ok(id)
    }

    pub fn request_prepare_rename(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::PrepareRename {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_rename(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        new_name: impl Into<String>,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::Rename {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
            new_name: new_name.into(),
        })
    }

    pub fn request_code_actions(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        range: LanguageLocationRange,
        diagnostics: Vec<LanguageDiagnostic>,
        only: Vec<String>,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::CodeActions {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            range,
            diagnostics,
            only,
        })
    }

    pub fn request_resolve_code_action(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        provider_data: serde_json::Value,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ResolveCodeAction {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            provider_data,
        })
    }

    pub fn request_document_formatting(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        options: LanguageFormattingOptions,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::DocumentFormatting {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            options,
        })
    }

    pub fn request_range_formatting(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
        options: LanguageFormattingOptions,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::RangeFormatting {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            range,
            options,
        })
    }

    pub fn request_signature_help(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
        trigger: LanguageSignatureHelpTrigger,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::SignatureHelp {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
            trigger,
        })
    }

    pub fn request_inlay_hints(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::InlayHints {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            range,
        })
    }

    pub fn request_linked_editing_ranges(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        position: LanguageDocumentPosition,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::LinkedEditingRanges {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            position,
        })
    }

    pub fn request_semantic_tokens(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::SemanticTokens {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn request_document_symbols(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::DocumentSymbols {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn request_code_lenses(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::CodeLenses {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn resolve_code_lens(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        lens: LanguageCodeLens,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ResolveCodeLens {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            lens,
        })
    }

    pub fn request_document_links(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::DocumentLinks {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn resolve_document_link(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        link: LanguageDocumentLink,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ResolveDocumentLink {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            link,
        })
    }

    pub fn request_document_colors(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::DocumentColors {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn request_color_presentations(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
        range: LanguageTextRange,
        color: LanguageColor,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::ColorPresentations {
            id: self.next_request_id(),
            path: path.into(),
            revision,
            range,
            color,
        })
    }

    pub fn request_folding_ranges(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::FoldingRanges {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn request_document_diagnostics(
        &self,
        path: impl Into<PathBuf>,
        revision: LanguageDocumentRevision,
    ) -> Result<LanguageRequestId, LspManagerError> {
        self.queue_request(PendingLanguageRequest::DocumentDiagnostics {
            id: self.next_request_id(),
            path: path.into(),
            revision,
        })
    }

    pub fn shutdown(mut self) -> Result<(), LspManagerError> {
        let (completion, response) = std_mpsc::sync_channel(1);
        self.send(SupervisorCommand::Shutdown { completion })?;
        response
            .recv_timeout(SHUTDOWN_TIMEOUT)
            .map_err(|_| LspManagerError::ShutdownTimeout)?;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }

    fn send(&self, command: SupervisorCommand) -> Result<(), LspManagerError> {
        self.commands
            .send(command)
            .map_err(|_| LspManagerError::Closed)
    }

    fn queue_request(
        &self,
        request: PendingLanguageRequest,
    ) -> Result<LanguageRequestId, LspManagerError> {
        let id = request.id();
        self.send(SupervisorCommand::LanguageRequest(request))?;
        Ok(id)
    }

    fn next_request_id(&self) -> LanguageRequestId {
        LanguageRequestId::new(self.next_request_id.fetch_add(1, Ordering::Relaxed))
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let (completion, _) = std_mpsc::sync_channel(1);
            let _ = self
                .commands
                .send(SupervisorCommand::Shutdown { completion });
        }
    }
}

enum SupervisorCommand {
    Synchronize(LspDocumentSnapshot),
    Save(PathBuf),
    Close(PathBuf),
    SetEnablement(LspManagerEnablement),
    ProtocolEvent {
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        event: LanguageServerEvent,
    },
    ServerStarted {
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        route: LanguageServerRoute,
        result: Result<LanguageServerClient, String>,
    },
    RetryServer {
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
    },
    LanguageRequest(PendingLanguageRequest),
    CancelLanguageRequest(LanguageRequestId),
    WorkspaceSymbols {
        id: LanguageRequestId,
        language_id: String,
        query: String,
    },
    WorkspaceSymbolsCompleted {
        id: LanguageRequestId,
        query: String,
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<LanguageSymbols, String>,
    },
    DirectoryDiagnostics {
        id: LanguageRequestId,
        language_id: String,
    },
    DirectoryDiagnosticsCompleted {
        id: LanguageRequestId,
        language_id: String,
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<LanguageDirectoryDiagnostics, String>,
    },
    LanguageRequestCompleted {
        request_id: LanguageRequestId,
        server: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<CompletedLanguageRequest, String>,
    },
    Shutdown {
        completion: std_mpsc::SyncSender<()>,
    },
}

struct DocumentState {
    document: LspDocumentSnapshot,
    uri: Uri,
    routed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManagedServerPhase {
    Stopped,
    Starting,
    Ready,
    BackingOff,
    Terminal,
}

struct ManagedServer {
    definition: LanguageServerDefinition,
    epoch: u64,
    phase: ManagedServerPhase,
    restart: ServerRestartTracker,
}

struct InFlightLanguageRequest {
    cancellation: CancellationSource,
    kind: LanguageRequestKind,
    server: LanguageServerName,
    server_epoch: u64,
    configuration_generation: u64,
    service_generation: u64,
    cold_for_incarnation: bool,
    started: Instant,
}

struct Supervisor {
    configuration: LspManagerConfiguration,
    events: Arc<dyn LspManagerEventSink>,
    metrics: Option<Arc<dyn LspRequestMetricsSink>>,
    commands: mpsc::UnboundedSender<SupervisorCommand>,
    router: LanguageServerDocumentRouter,
    documents: BTreeMap<PathBuf, DocumentState>,
    uri_paths: HashMap<Uri, PathBuf>,
    servers: BTreeMap<LanguageServerName, ManagedServer>,
    launches: HashMap<LanguageServerName, tokio::task::JoinHandle<()>>,
    retry_tasks: HashMap<LanguageServerName, tokio::task::JoinHandle<()>>,
    in_flight_requests: BTreeMap<LanguageRequestId, InFlightLanguageRequest>,
    observed_request_kinds: BTreeSet<(LanguageServerName, u64, LanguageRequestKind)>,
    generation: u64,
}

impl Supervisor {
    fn new(
        configuration: LspManagerConfiguration,
        events: Arc<dyn LspManagerEventSink>,
        metrics: Option<Arc<dyn LspRequestMetricsSink>>,
        commands: mpsc::UnboundedSender<SupervisorCommand>,
    ) -> Self {
        let servers = configuration
            .servers
            .iter()
            .cloned()
            .map(|definition| {
                (
                    definition.name().clone(),
                    ManagedServer {
                        definition,
                        epoch: 0,
                        phase: ManagedServerPhase::Stopped,
                        restart: ServerRestartTracker::default(),
                    },
                )
            })
            .collect();
        Self {
            configuration,
            events,
            metrics,
            commands,
            router: LanguageServerDocumentRouter::default(),
            documents: BTreeMap::new(),
            uri_paths: HashMap::new(),
            servers,
            launches: HashMap::new(),
            retry_tasks: HashMap::new(),
            in_flight_requests: BTreeMap::new(),
            observed_request_kinds: BTreeSet::new(),
            generation: 0,
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<SupervisorCommand>) {
        if self.configuration.enablement == LspManagerEnablement::Enabled {
            self.enable().await;
        }
        while let Some(command) = commands.recv().await {
            match command {
                SupervisorCommand::Synchronize(document) => self.synchronize(document).await,
                SupervisorCommand::Save(path) => self.save(&path).await,
                SupervisorCommand::Close(path) => self.close(&path).await,
                SupervisorCommand::SetEnablement(enablement) => {
                    self.set_enablement(enablement).await;
                }
                SupervisorCommand::ProtocolEvent {
                    server,
                    generation,
                    server_epoch,
                    event,
                } if generation == self.generation => {
                    self.handle_protocol_event(server, server_epoch, event)
                        .await;
                }
                SupervisorCommand::ProtocolEvent { .. } => {}
                SupervisorCommand::ServerStarted {
                    server,
                    generation,
                    server_epoch,
                    route,
                    result,
                } => {
                    self.handle_server_started(server, generation, server_epoch, route, result)
                        .await;
                }
                SupervisorCommand::RetryServer {
                    server,
                    generation,
                    server_epoch,
                } if generation == self.generation => {
                    self.retry_server(&server, server_epoch);
                }
                SupervisorCommand::RetryServer { .. } => {}
                SupervisorCommand::LanguageRequest(request) => {
                    self.begin_language_request(request);
                }
                SupervisorCommand::CancelLanguageRequest(request_id) => {
                    self.cancel_language_request(request_id);
                }
                SupervisorCommand::WorkspaceSymbols {
                    id,
                    language_id,
                    query,
                } => {
                    self.begin_workspace_symbols(id, language_id, query);
                }
                SupervisorCommand::WorkspaceSymbolsCompleted {
                    id,
                    query,
                    server,
                    generation,
                    server_epoch,
                    result,
                } => {
                    self.complete_workspace_symbols(
                        id,
                        query,
                        server,
                        generation,
                        server_epoch,
                        result,
                    );
                }
                SupervisorCommand::DirectoryDiagnostics { id, language_id } => {
                    self.begin_workspace_diagnostics(id, language_id);
                }
                SupervisorCommand::DirectoryDiagnosticsCompleted {
                    id,
                    language_id,
                    server,
                    generation,
                    server_epoch,
                    result,
                } => {
                    self.complete_workspace_diagnostics(
                        id,
                        language_id,
                        server,
                        generation,
                        server_epoch,
                        result,
                    );
                }
                SupervisorCommand::LanguageRequestCompleted {
                    request_id,
                    server,
                    generation,
                    server_epoch,
                    result,
                } => {
                    self.complete_language_request(
                        request_id,
                        server,
                        generation,
                        server_epoch,
                        result,
                    );
                }
                SupervisorCommand::Shutdown { completion } => {
                    self.disable().await;
                    let _ = completion.send(());
                    return;
                }
            }
        }
        self.disable().await;
    }

    async fn set_enablement(&mut self, enablement: LspManagerEnablement) {
        if self.configuration.enablement == enablement {
            return;
        }
        self.configuration.enablement = enablement;
        match enablement {
            LspManagerEnablement::Disabled => self.disable().await,
            LspManagerEnablement::Enabled => self.enable().await,
        }
    }

    async fn synchronize(&mut self, document: LspDocumentSnapshot) {
        let path = self.absolute_path(document.path());
        if let Some(current) = self.documents.get(&path)
            && document.revision() <= current.document.revision()
        {
            if document.revision() == current.document.revision()
                && document.text() == current.document.text()
                && document.language_id() == current.document.language_id()
            {
                return;
            }
            self.emit_document_failure(
                path,
                LspDocumentOperation::Synchronize,
                "document revision did not advance".into(),
            );
            return;
        }
        let uri = match file_uri(&path) {
            Ok(uri) => uri,
            Err(error) => {
                self.emit_document_failure(
                    path,
                    LspDocumentOperation::Synchronize,
                    error.to_string(),
                );
                return;
            }
        };
        let language_changed = self
            .documents
            .get(&path)
            .is_some_and(|current| current.document.language_id() != document.language_id());
        if language_changed {
            self.close_routed(&path).await;
        }
        self.uri_paths.insert(uri.clone(), path.clone());
        let was_routed = self
            .documents
            .get(&path)
            .is_some_and(|current| current.routed);
        self.documents.insert(
            path.clone(),
            DocumentState {
                document,
                uri,
                routed: was_routed && !language_changed,
            },
        );
        if self.configuration.enablement == LspManagerEnablement::Enabled {
            self.route_current_document(&path).await;
        }
    }

    async fn route_current_document(&mut self, path: &Path) {
        let Some(current) = self.documents.get(path) else {
            return;
        };
        if !self.supports_language(current.document.language_id()) {
            return;
        }
        let snapshot = match router_snapshot(current) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.emit_document_failure(
                    path.to_path_buf(),
                    LspDocumentOperation::Synchronize,
                    error.to_string(),
                );
                return;
            }
        };
        let result = if current.routed {
            self.router.update_document(snapshot).await
        } else {
            self.router.open_document(snapshot).await
        };
        match result {
            Ok(_) => {
                if let Some(current) = self.documents.get_mut(path) {
                    current.routed = true;
                }
            }
            Err(error) => self.emit_document_failure(
                path.to_path_buf(),
                LspDocumentOperation::Synchronize,
                error.to_string(),
            ),
        }
    }

    async fn save(&mut self, requested: &Path) {
        let path = self.absolute_path(requested);
        let Some(document) = self.documents.get(&path) else {
            return;
        };
        if !document.routed {
            return;
        }
        if let Err(error) = self.router.save_document(&document.uri).await {
            self.emit_document_failure(path, LspDocumentOperation::Save, error.to_string());
        }
    }

    async fn close(&mut self, requested: &Path) {
        let path = self.absolute_path(requested);
        self.close_routed(&path).await;
        if let Some(document) = self.documents.remove(&path) {
            self.uri_paths.remove(&document.uri);
        }
    }

    async fn close_routed(&mut self, path: &Path) {
        let Some(document) = self.documents.get(path) else {
            return;
        };
        if !document.routed {
            return;
        }
        if let Err(error) = self.router.close_document(&document.uri).await {
            self.emit_document_failure(
                path.to_path_buf(),
                LspDocumentOperation::Close,
                error.to_string(),
            );
        }
        if let Some(document) = self.documents.get_mut(path) {
            document.routed = false;
        }
    }

    async fn handle_protocol_event(
        &mut self,
        server: LanguageServerName,
        server_epoch: u64,
        event: LanguageServerEvent,
    ) {
        let Some(phase) = self
            .servers
            .get(&server)
            .filter(|managed| managed.epoch == server_epoch)
            .map(|managed| managed.phase)
        else {
            return;
        };
        match (phase, event) {
            (ManagedServerPhase::Starting, LanguageServerEvent::TransportClosed { message }) => {
                self.schedule_failure(&server, server_epoch, message)
            }
            (ManagedServerPhase::Ready, LanguageServerEvent::TransportClosed { message }) => {
                self.handle_server_disconnect(&server, server_epoch, message)
                    .await;
            }
            (ManagedServerPhase::Ready, LanguageServerEvent::Diagnostics(params)) => {
                self.publish_diagnostics(params);
            }
            (ManagedServerPhase::Ready, LanguageServerEvent::LogMessage(message)) => self
                .emit_server_message(
                    server,
                    message.typ,
                    LanguageServerMessageSource::Protocol,
                    false,
                    message.message,
                ),
            (ManagedServerPhase::Ready, LanguageServerEvent::ShowMessage(message)) => self
                .emit_server_message(
                    server,
                    message.typ,
                    LanguageServerMessageSource::Protocol,
                    true,
                    message.message,
                ),
            (ManagedServerPhase::Ready, LanguageServerEvent::DynamicCapabilitiesChanged(_)) => {
                self.emit_server_capabilities(&server, server_epoch)
            }
            (ManagedServerPhase::Starting, LanguageServerEvent::ServerStderr(message))
            | (ManagedServerPhase::Ready, LanguageServerEvent::ServerStderr(message)) => self
                .emit_server_message(
                    server,
                    MessageType::LOG,
                    LanguageServerMessageSource::Stderr,
                    false,
                    message,
                ),
            (ManagedServerPhase::Ready, LanguageServerEvent::Telemetry(_))
            | (ManagedServerPhase::Ready, LanguageServerEvent::WorkDoneProgressCreated(_))
            | (ManagedServerPhase::Ready, LanguageServerEvent::UnhandledNotification { .. })
            | (ManagedServerPhase::Ready, LanguageServerEvent::UnsupportedServerRequest { .. }) => {
            }
            (ManagedServerPhase::Ready, LanguageServerEvent::Progress(progress)) => {
                let ProgressParamsValue::WorkDone(progress_value) = progress.value;
                let (title, message, percentage, done) = match progress_value {
                    WorkDoneProgress::Begin(progress) => (
                        Some(progress.title),
                        progress.message,
                        progress.percentage,
                        false,
                    ),
                    WorkDoneProgress::Report(progress) => {
                        (None, progress.message, progress.percentage, false)
                    }
                    WorkDoneProgress::End(progress) => (None, progress.message, None, true),
                };
                self.emit_notification(LspManagerNotification::ServerProgress(
                    LanguageServerProgress {
                        server: server.to_string(),
                        token: progress_token(progress.token),
                        title,
                        message,
                        percentage,
                        done,
                    },
                ));
            }
            _ => {}
        }
    }

    fn publish_diagnostics(&self, params: PublishDiagnosticsParams) {
        let Some(path) = self.uri_paths.get(&params.uri) else {
            return;
        };
        let Some(document) = self.documents.get(path) else {
            return;
        };
        let Ok(binding) = self.router.document_version(&params.uri) else {
            return;
        };
        if params
            .version
            .is_some_and(|version| version != binding.server_version().value())
        {
            return;
        }
        let Ok(client) = self.router.client_for_document(&params.uri) else {
            return;
        };
        let encoding = &client.initialization().position_encoding;
        let diagnostics = params
            .diagnostics
            .into_iter()
            .filter_map(|diagnostic| {
                project_diagnostic(document.document.text(), diagnostic, encoding)
            })
            .collect();
        self.emit_notification(LspManagerNotification::Diagnostics(
            LanguageDiagnostics::new(path.clone(), document.document.revision(), diagnostics),
        ));
    }

    fn absolute_path(&self, path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.configuration.dir_root.join(path)
        }
    }

    fn supports_language(&self, language_id: &str) -> bool {
        self.servers.values().any(|server| {
            server.phase == ManagedServerPhase::Ready
                && server
                    .definition
                    .language_ids()
                    .any(|known| known == language_id)
        })
    }

    fn emit_server_state(&self, server: &LanguageServerName, state: LanguageServerState) {
        self.emit_notification(LspManagerNotification::ServerStateChanged {
            server: server.to_string(),
            state,
        });
    }

    fn emit_server_message(
        &self,
        server: LanguageServerName,
        message_type: MessageType,
        source: LanguageServerMessageSource,
        show: bool,
        message: String,
    ) {
        self.emit_notification(LspManagerNotification::ServerMessage {
            server: server.to_string(),
            severity: language_server_message_severity(message_type),
            source,
            show,
            message,
        });
    }

    fn emit_server_capabilities(&self, server: &LanguageServerName, server_epoch: u64) {
        let Ok(client) = self.router.client_for_server(server) else {
            return;
        };
        self.emit_notification(LspManagerNotification::CapabilitiesChanged {
            server: server.to_string(),
            capabilities: request_runtime::capability_snapshot(client, server_epoch),
        });
    }

    fn emit_document_failure(
        &self,
        path: PathBuf,
        operation: LspDocumentOperation,
        message: String,
    ) {
        self.emit_notification(LspManagerNotification::DocumentOperationFailed {
            path,
            operation,
            message,
        });
    }

    fn emit(&self, event: impl Into<LspManagerEvent>) {
        self.events.on_event(event.into());
    }

    fn emit_notification(&self, notification: LspManagerNotification) {
        self.emit(LspManagerEvent::Notification(notification));
    }

    fn emit_request_result(&self, result: LspManagerRequestResult) {
        self.emit(LspManagerEvent::RequestResult(result));
    }
}

fn language_server_message_severity(message_type: MessageType) -> LanguageServerMessageSeverity {
    if message_type == MessageType::ERROR {
        LanguageServerMessageSeverity::Error
    } else if message_type == MessageType::WARNING {
        LanguageServerMessageSeverity::Warning
    } else if message_type == MessageType::INFO {
        LanguageServerMessageSeverity::Information
    } else {
        LanguageServerMessageSeverity::Log
    }
}

fn progress_token(token: NumberOrString) -> String {
    match token {
        NumberOrString::Number(token) => token.to_string(),
        NumberOrString::String(token) => token,
    }
}

struct ProtocolEventBridge {
    server: LanguageServerName,
    generation: u64,
    server_epoch: u64,
    commands: mpsc::UnboundedSender<SupervisorCommand>,
}

impl LanguageServerHost for ProtocolEventBridge {
    fn on_event(&self, event: LanguageServerEvent) {
        let _ = self.commands.send(SupervisorCommand::ProtocolEvent {
            server: self.server.clone(),
            generation: self.generation,
            server_epoch: self.server_epoch,
            event,
        });
    }
}

fn validate_definitions(configuration: &LspManagerConfiguration) -> Result<(), LspManagerError> {
    let mut names = BTreeSet::new();
    let mut languages = BTreeSet::new();
    for definition in &configuration.servers {
        if !names.insert(definition.name().to_string()) {
            return Err(LspManagerError::DuplicateServer(
                definition.name().to_string(),
            ));
        }
        for language in definition.language_ids() {
            if !languages.insert(language.to_owned()) {
                return Err(LspManagerError::DuplicateLanguage(language.to_owned()));
            }
        }
    }
    file_uri(&configuration.dir_root).map(|_| ())
}

fn router_snapshot(current: &DocumentState) -> Result<LanguageDocumentSnapshot, LspManagerError> {
    Ok(LanguageDocumentSnapshot::new(
        current.uri.clone(),
        current.document.language_id(),
        EditorDocumentRevision::new(current.document.revision().value()),
        current.document.text(),
    )?)
}

fn file_uri(path: &Path) -> Result<Uri, LspManagerError> {
    let url = url::Url::from_file_path(path)
        .map_err(|_| LspManagerError::InvalidDocumentUri(path.to_string_lossy().into_owned()))?;
    Uri::from_str(url.as_str())
        .map_err(|_| LspManagerError::InvalidDocumentUri(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
