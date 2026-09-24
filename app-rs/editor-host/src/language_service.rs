#[path = "language_service_remote.rs"]
pub(crate) mod remote;
#[path = "language_service_remote_session.rs"]
mod remote_session;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use self::remote::protocol_document;
use self::remote::protocol_location_kind;
use self::remote::protocol_position;
use self::remote_session::RemoteLanguageSession;
use crate::FileEditorHost;
use crate::FileEditorTab;
use ash_app_server_protocol::protocol::config::{ConfigReadResult, LanguageServerModeDto};
use ash_app_server_protocol::protocol::language::LanguageCompletionTriggerKindDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionsParams;
use ash_app_server_protocol::protocol::language::LanguageHoverParams;
use ash_app_server_protocol::protocol::language::LanguageLocationsParams;
use ash_editor::{
    CodeEditorDiagnostic, CodeEditorDiagnosticSeverity, CodeEditorLanguage, CodeEditorRowSource,
};
use ash_install_context::InstallContext;
use ash_lsp_manager::{
    LanguageCompletionTrigger, LanguageCompletions, LanguageDocumentPosition,
    LanguageDocumentRevision, LanguageHover, LanguageLocations, LanguageRequestId,
    LanguageRequestKind, LanguageServerState, LanguageService, LanguageServiceConfiguration,
    LanguageServiceDocument, LanguageServiceEvent, LanguageServiceEventSink,
};
use ash_lsp_server_provider::{
    BASH_LANGUAGE_SERVER_ID, JSON_LANGUAGE_SERVER_ID, LanguageServerCatalog,
    LanguageServerExecutionPolicy, LanguageServerPreference, RUST_ANALYZER_SERVER_ID,
    TYPESCRIPT_LANGUAGE_SERVER_ID,
};

struct FileEditorLanguageServiceEventSink {
    events: Arc<dyn FileEditorLanguageEventSink>,
}

impl LanguageServiceEventSink for FileEditorLanguageServiceEventSink {
    fn on_event(&self, event: LanguageServiceEvent) {
        let _ = self.events.send(FileEditorLanguageEvent::Local(event));
    }
}

/// Language-service event delivered to the product event loop.
pub enum FileEditorLanguageEvent {
    Local(LanguageServiceEvent),
    Remote(remote::RemoteLanguageEvent),
}

/// Sends language-service events through the product's event-loop wakeup mechanism.
pub trait FileEditorLanguageEventSink: Send + Sync {
    fn send(&self, event: FileEditorLanguageEvent) -> std::result::Result<(), String>;
}

/// Opens the dedicated App Server connection used by remote editor language requests.
pub trait RemoteLanguageSessionTarget: Send + Sync {
    fn is_remote(&self) -> bool;
    fn start(&self) -> anyhow::Result<ash_app_server_client::AppServerSession>;
}

/// Desktop composition adapter between retained file tabs and the product language service.
pub struct FileEditorLanguageService {
    service: Option<LanguageService>,
    remote: Option<RemoteLanguageSession>,
    is_remote: bool,
    catalog: LanguageServerCatalog,
    install_context: InstallContext,
    config_generation: Option<u64>,
    dir_root: PathBuf,
    diagnostics: HashMap<PathBuf, FileEditorDocumentDiagnostics>,
    server_states: HashMap<String, LanguageServerState>,
    hover: Option<LanguageHover>,
    completions: Option<LanguageCompletions>,
    definitions: Option<LanguageLocations>,
    request_error: Option<String>,
    pending_requests: PendingLanguageRequests,
    events: Arc<dyn FileEditorLanguageEventSink>,
}

impl FileEditorLanguageService {
    /// Creates the host adapter without starting a local language-server process.
    ///
    /// Creates a Remote adapter before the shared Agent connection becomes available.
    pub fn remote(dir_root: &Path, events: Arc<dyn FileEditorLanguageEventSink>) -> Self {
        Self {
            service: None,
            remote: None,
            is_remote: true,
            catalog: LanguageServerCatalog::default(),
            install_context: InstallContext::current(),
            config_generation: None,
            dir_root: dir_root.to_path_buf(),
            diagnostics: HashMap::new(),
            server_states: HashMap::new(),
            hover: None,
            completions: None,
            definitions: None,
            request_error: None,
            pending_requests: PendingLanguageRequests::default(),
            events,
        }
    }

    pub fn start(dir_root: &Path, events: Arc<dyn FileEditorLanguageEventSink>) -> Self {
        // Persisted configuration is the canonical owner of language-server enablement. Keep the
        // local service disabled until that configuration arrives instead of briefly launching
        // every executable discovered on PATH.
        let catalog = LanguageServerCatalog::disabled();
        let install_context = InstallContext::current();
        let service_events = Arc::new(FileEditorLanguageServiceEventSink {
            events: Arc::clone(&events),
        });
        let service = LanguageService::start(
            resolve_configuration(&catalog, &install_context, dir_root),
            service_events,
        )
        .map_err(|error| eprintln!("could not start language service: {error}"))
        .ok();
        Self {
            service,
            remote: None,
            is_remote: false,
            catalog,
            install_context,
            config_generation: None,
            dir_root: dir_root.to_path_buf(),
            diagnostics: HashMap::new(),
            server_states: HashMap::new(),
            hover: None,
            completions: None,
            definitions: None,
            request_error: None,
            pending_requests: PendingLanguageRequests::default(),
            events,
        }
    }

    fn attach_remote(&mut self, remote: RemoteLanguageSession) {
        self.remote = Some(remote);
    }

    pub fn start_remote(
        &mut self,
        target: Arc<dyn RemoteLanguageSessionTarget>,
    ) -> anyhow::Result<()> {
        self.attach_remote(RemoteLanguageSession::spawn(
            Arc::clone(&self.events),
            target,
        )?);
        Ok(())
    }

    pub fn set_dir_root(&mut self, dir_root: &Path) {
        self.shutdown_service();
        if self.is_remote {
            self.dir_root = dir_root.to_path_buf();
            self.diagnostics.clear();
            self.server_states.clear();
            self.clear_requests();
            return;
        }
        let service_events = Arc::new(FileEditorLanguageServiceEventSink {
            events: Arc::clone(&self.events),
        });
        self.service = LanguageService::start(
            resolve_configuration(&self.catalog, &self.install_context, dir_root),
            service_events,
        )
        .map_err(|error| eprintln!("could not restart language service: {error}"))
        .ok();
        self.dir_root = dir_root.to_path_buf();
        self.diagnostics.clear();
        self.server_states.clear();
        self.clear_requests();
    }

    pub fn apply_configuration(&mut self, configuration: &ConfigReadResult, host: &FileEditorHost) {
        if self
            .config_generation
            .is_some_and(|generation| generation >= configuration.generation)
        {
            return;
        }
        self.config_generation = Some(configuration.generation);
        let catalog = catalog_from_configuration(configuration);
        if catalog == self.catalog {
            return;
        }
        self.catalog = catalog;
        if self.is_remote {
            self.diagnostics.clear();
            self.server_states.clear();
            self.clear_requests();
            return;
        }
        self.shutdown_service();
        let service_events = Arc::new(FileEditorLanguageServiceEventSink {
            events: Arc::clone(&self.events),
        });
        self.service = LanguageService::start(
            resolve_configuration(&self.catalog, &self.install_context, &self.dir_root),
            service_events,
        )
        .map_err(|error| eprintln!("could not reconfigure language service: {error}"))
        .ok();
        self.diagnostics.clear();
        self.server_states.clear();
        self.clear_requests();
        self.synchronize_all(host);
    }

    fn shutdown_service(&mut self) {
        let Some(service) = self.service.take() else {
            return;
        };
        if let Err(error) = service.shutdown() {
            eprintln!("could not shut down language service: {error}");
        }
    }

    pub fn synchronize_active(&self, host: &FileEditorHost) {
        let Some(tab) = host.active() else {
            return;
        };
        let Ok(document) = language_document(&self.dir_root, tab) else {
            return;
        };
        if let Some(remote) = self.remote.as_ref() {
            if let Err(error) = remote.synchronize(protocol_document(document)) {
                eprintln!("could not synchronize Remote language document: {error}");
            }
            return;
        }
        let Some(service) = self.service.as_ref() else {
            return;
        };
        if let Err(error) = service.synchronize_document(document) {
            eprintln!("could not synchronize language document: {error}");
        }
    }

    pub fn active_editor_diagnostics(&self, host: &FileEditorHost) -> &[CodeEditorDiagnostic] {
        let Some(tab) = host.active() else {
            return &[];
        };
        let Some(diagnostics) = self.diagnostics.get(&self.absolute_path(tab.path())) else {
            return &[];
        };
        if diagnostics.revision != tab.document().revision().value() {
            return &[];
        }
        &diagnostics.items
    }

    pub fn active_hover(&self, host: &FileEditorHost) -> Option<&LanguageHover> {
        let tab = host.active()?;
        self.hover.as_ref().filter(|hover| {
            hover.path == self.absolute_path(tab.path())
                && hover.revision.value() == tab.document().revision().value()
        })
    }

    pub fn active_completions(&self, host: &FileEditorHost) -> Option<&LanguageCompletions> {
        let tab = host.active()?;
        self.completions.as_ref().filter(|result| {
            result.path == self.absolute_path(tab.path())
                && result.revision.value() == tab.document().revision().value()
        })
    }

    pub fn take_definitions(&mut self) -> Option<LanguageLocations> {
        self.definitions.take()
    }

    pub fn dismiss_completions(&mut self) {
        self.completions = None;
        self.pending_requests.clear(LanguageRequestKind::Completion);
    }

    pub fn dismiss_hover(&mut self) {
        self.hover = None;
        self.pending_requests.clear(LanguageRequestKind::Hover);
    }

    pub fn request_active(&mut self, host: &FileEditorHost, kind: LanguageRequestKind) {
        let Some(position) = host.active().and_then(|tab| tab.document().caret()) else {
            return;
        };
        self.request_active_at(host, kind, position);
    }

    pub fn request_active_at(
        &mut self,
        host: &FileEditorHost,
        kind: LanguageRequestKind,
        position: ash_editor::CodeEditorPosition,
    ) {
        let Some(tab) = host.active() else {
            return;
        };
        let path = self.absolute_path(tab.path());
        let revision = LanguageDocumentRevision::new(tab.document().revision().value());
        let position = LanguageDocumentPosition::new(
            u32::try_from(position.row_index).unwrap_or(u32::MAX),
            u32::try_from(position.byte_offset).unwrap_or(u32::MAX),
        );
        self.request_error = None;
        self.pending_requests.clear(kind);
        if let Some(remote) = self.remote.as_ref() {
            let Ok(document) = language_document(&self.dir_root, tab) else {
                return;
            };
            let Some(protocol_position) = protocol_position(document.text(), position) else {
                self.request_error = Some("language request position is invalid".into());
                return;
            };
            let document = protocol_document(document);
            let result = match kind {
                LanguageRequestKind::Hover => {
                    self.hover = None;
                    remote.hover(LanguageHoverParams {
                        document,
                        position: protocol_position,
                    })
                }
                LanguageRequestKind::Completion => {
                    self.completions = None;
                    remote.completions(LanguageCompletionsParams {
                        document,
                        position: protocol_position,
                        trigger_kind: LanguageCompletionTriggerKindDto::Invoke,
                        trigger_character: None,
                    })
                }
                LanguageRequestKind::Declaration
                | LanguageRequestKind::Definition
                | LanguageRequestKind::Implementation
                | LanguageRequestKind::TypeDefinition
                | LanguageRequestKind::References => {
                    self.definitions = None;
                    remote.locations(LanguageLocationsParams {
                        document,
                        position: protocol_position,
                        kind: protocol_location_kind(kind),
                        include_declaration: kind == LanguageRequestKind::References,
                    })
                }
                _ => return,
            };
            match result {
                Ok(request_id) => self.pending_requests.set_value(kind, request_id),
                Err(error) => self.request_error = Some(error.to_string()),
            }
            return;
        }
        let Some(service) = self.service.as_ref() else {
            return;
        };
        let result = match kind {
            LanguageRequestKind::Hover => {
                self.hover = None;
                service.request_hover(path, revision, position)
            }
            LanguageRequestKind::Completion => {
                self.completions = None;
                service.request_completions(
                    path,
                    revision,
                    position,
                    LanguageCompletionTrigger::Invoked,
                )
            }
            LanguageRequestKind::Definition => {
                self.definitions = None;
                service.request_definition(path, revision, position)
            }
            LanguageRequestKind::Declaration => {
                service.request_declaration(path, revision, position)
            }
            LanguageRequestKind::Implementation => {
                service.request_implementation(path, revision, position)
            }
            LanguageRequestKind::TypeDefinition => {
                service.request_type_definition(path, revision, position)
            }
            LanguageRequestKind::References => {
                service.request_references(path, revision, position, true)
            }
            LanguageRequestKind::PrepareCallHierarchy
            | LanguageRequestKind::IncomingCalls
            | LanguageRequestKind::OutgoingCalls
            | LanguageRequestKind::PrepareTypeHierarchy
            | LanguageRequestKind::Supertypes
            | LanguageRequestKind::Subtypes
            | LanguageRequestKind::WorkspaceSymbols
            | LanguageRequestKind::PrepareRename
            | LanguageRequestKind::Rename
            | LanguageRequestKind::CodeActions
            | LanguageRequestKind::ResolveCodeAction => return,
            _ => return,
        };
        match result {
            Ok(request_id) => self.pending_requests.set(kind, request_id),
            Err(error) => self.request_error = Some(error.to_string()),
        }
    }

    fn synchronize_all(&self, host: &FileEditorHost) {
        if let Some(remote) = self.remote.as_ref() {
            for tab in host.tabs() {
                let Ok(document) = language_document(&self.dir_root, tab) else {
                    continue;
                };
                if let Err(error) = remote.synchronize(protocol_document(document)) {
                    eprintln!("could not synchronize Remote language document: {error}");
                }
            }
            return;
        }
        let Some(service) = self.service.as_ref() else {
            return;
        };
        for tab in host.tabs() {
            let Ok(document) = language_document(&self.dir_root, tab) else {
                continue;
            };
            if let Err(error) = service.synchronize_document(document) {
                eprintln!("could not synchronize language document: {error}");
            }
        }
    }

    pub fn save(&self, path: &Path) {
        if self.is_remote {
            return;
        }
        let Some(service) = self.service.as_ref() else {
            return;
        };
        if let Err(error) = service.save_document(self.absolute_path(path)) {
            eprintln!("could not synchronize language document save: {error}");
        }
    }

    pub fn close(&mut self, path: &Path) {
        let absolute = self.absolute_path(path);
        self.diagnostics.remove(&absolute);
        self.clear_requests();
        if let Some(remote) = self.remote.as_ref() {
            if let Err(error) = remote.close(absolute) {
                eprintln!("could not close Remote language document: {error}");
            }
            return;
        }
        let Some(service) = self.service.as_ref() else {
            return;
        };
        if let Err(error) = service.close_document(absolute) {
            eprintln!("could not close language document: {error}");
        }
    }

    fn handle_local_event(&mut self, event: LanguageServiceEvent, host: &FileEditorHost) {
        match event {
            LanguageServiceEvent::Diagnostics(diagnostics) => {
                let current = host.tabs().iter().find(|tab| {
                    self.absolute_path(tab.path()) == diagnostics.path()
                        && tab.document().revision().value() == diagnostics.revision().value()
                });
                if current.is_some() {
                    let revision = diagnostics.revision().value();
                    let items = diagnostics
                        .diagnostics()
                        .iter()
                        .map(editor_diagnostic)
                        .collect();
                    self.diagnostics.insert(
                        diagnostics.path().to_path_buf(),
                        FileEditorDocumentDiagnostics { revision, items },
                    );
                }
            }
            LanguageServiceEvent::ServerStateChanged { server, state } => {
                eprintln!("language server {server}: {state:?}");
                self.server_states.insert(server, state);
            }
            LanguageServiceEvent::ServerMessage {
                server, message, ..
            } => {
                eprintln!("language server {server}: {message}");
            }
            LanguageServiceEvent::DocumentOperationFailed {
                path,
                operation,
                message,
            } => {
                eprintln!(
                    "language document {} {operation:?} failed: {message}",
                    path.display()
                );
            }
            LanguageServiceEvent::Hover(hover) => {
                if !self
                    .pending_requests
                    .complete(LanguageRequestKind::Hover, hover.request_id)
                {
                    return;
                }
                self.hover = Some(hover);
                self.request_error = None;
            }
            LanguageServiceEvent::Completions(completions) => {
                if !self
                    .pending_requests
                    .complete(LanguageRequestKind::Completion, completions.request_id)
                {
                    return;
                }
                self.completions = Some(completions);
                self.request_error = None;
            }
            LanguageServiceEvent::Locations(definitions) => {
                let request_kind = match definitions.kind {
                    ash_lsp_manager::LanguageLocationKind::Declaration => {
                        LanguageRequestKind::Declaration
                    }
                    ash_lsp_manager::LanguageLocationKind::Definition => {
                        LanguageRequestKind::Definition
                    }
                    ash_lsp_manager::LanguageLocationKind::Implementation => {
                        LanguageRequestKind::Implementation
                    }
                    ash_lsp_manager::LanguageLocationKind::TypeDefinition => {
                        LanguageRequestKind::TypeDefinition
                    }
                    ash_lsp_manager::LanguageLocationKind::Reference => {
                        LanguageRequestKind::References
                    }
                };
                if !self
                    .pending_requests
                    .complete(request_kind, definitions.request_id)
                {
                    return;
                }
                self.definitions = Some(definitions);
                self.request_error = None;
            }
            LanguageServiceEvent::Hierarchy(_)
            | LanguageServiceEvent::WorkspaceSymbols(_)
            | LanguageServiceEvent::RenamePreparation(_)
            | LanguageServiceEvent::WorkspaceEdit(_)
            | LanguageServiceEvent::CodeActions(_) => {}
            LanguageServiceEvent::RequestFailed {
                request_id,
                kind,
                path,
                message,
                ..
            } => {
                if !self.pending_requests.complete(kind, request_id) {
                    return;
                }
                if kind == LanguageRequestKind::Hover {
                    self.hover = None;
                } else {
                    eprintln!(
                        "language request {kind:?} for {} failed: {message}",
                        path.display()
                    );
                    self.request_error = Some(message);
                }
            }
            _ => {}
        }
    }

    pub fn handle_event(&mut self, event: FileEditorLanguageEvent, host: &FileEditorHost) {
        match event {
            FileEditorLanguageEvent::Local(event) => self.handle_local_event(event, host),
            FileEditorLanguageEvent::Remote(event) => self.handle_remote_event(event, host),
        }
    }

    fn clear_requests(&mut self) {
        self.hover = None;
        self.completions = None;
        self.definitions = None;
        self.request_error = None;
        self.pending_requests = PendingLanguageRequests::default();
    }

    fn absolute_path(&self, path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.dir_root.join(path)
        }
    }
}

impl Drop for FileEditorLanguageService {
    fn drop(&mut self) {
        self.shutdown_service();
    }
}

#[derive(Default)]
struct PendingLanguageRequests {
    hover: Option<u64>,
    completion: Option<u64>,
    definition: Option<u64>,
}

impl PendingLanguageRequests {
    fn set(&mut self, kind: LanguageRequestKind, request_id: LanguageRequestId) {
        self.set_value(kind, request_id.value());
    }

    fn set_value(&mut self, kind: LanguageRequestKind, request_id: u64) {
        *self.slot(kind) = Some(request_id);
    }

    fn clear(&mut self, kind: LanguageRequestKind) {
        *self.slot(kind) = None;
    }

    fn complete(&mut self, kind: LanguageRequestKind, request_id: LanguageRequestId) -> bool {
        self.complete_value(kind, request_id.value())
    }

    fn complete_value(&mut self, kind: LanguageRequestKind, request_id: u64) -> bool {
        let slot = self.slot(kind);
        if *slot != Some(request_id) {
            return false;
        }
        *slot = None;
        true
    }

    fn slot(&mut self, kind: LanguageRequestKind) -> &mut Option<u64> {
        match kind {
            LanguageRequestKind::Hover => &mut self.hover,
            LanguageRequestKind::Completion => &mut self.completion,
            LanguageRequestKind::Declaration
            | LanguageRequestKind::Definition
            | LanguageRequestKind::Implementation
            | LanguageRequestKind::TypeDefinition
            | LanguageRequestKind::References => &mut self.definition,
            _ => &mut self.definition,
        }
    }
}

struct FileEditorDocumentDiagnostics {
    revision: u64,
    items: Vec<CodeEditorDiagnostic>,
}

fn editor_diagnostic(diagnostic: &ash_lsp_manager::LanguageDiagnostic) -> CodeEditorDiagnostic {
    let severity = match diagnostic.severity {
        ash_lsp_manager::LanguageDiagnosticSeverity::Error => CodeEditorDiagnosticSeverity::Error,
        ash_lsp_manager::LanguageDiagnosticSeverity::Warning => {
            CodeEditorDiagnosticSeverity::Warning
        }
        ash_lsp_manager::LanguageDiagnosticSeverity::Information => {
            CodeEditorDiagnosticSeverity::Information
        }
        ash_lsp_manager::LanguageDiagnosticSeverity::Hint => CodeEditorDiagnosticSeverity::Hint,
    };
    let mut projected =
        CodeEditorDiagnostic::new(diagnostic.range.byte_range(), severity, &diagnostic.message);
    if let Some(source) = diagnostic.source.as_deref() {
        projected = projected.with_source(source);
    }
    if let Some(code) = diagnostic.code.as_deref() {
        projected = projected.with_code(code);
    }
    projected
}

fn catalog_from_configuration(configuration: &ConfigReadResult) -> LanguageServerCatalog {
    LanguageServerCatalog::new(server_preference(configuration, RUST_ANALYZER_SERVER_ID))
        .with_json_language_server(server_preference(configuration, JSON_LANGUAGE_SERVER_ID))
        .with_bash_language_server(server_preference(configuration, BASH_LANGUAGE_SERVER_ID))
        .with_typescript_language_server(server_preference(
            configuration,
            TYPESCRIPT_LANGUAGE_SERVER_ID,
        ))
}

fn server_preference(
    configuration: &ConfigReadResult,
    server_id: &str,
) -> LanguageServerPreference {
    let Some(config) = configuration.language_servers.get(server_id) else {
        return LanguageServerPreference::disabled();
    };
    let preference = match config.mode {
        LanguageServerModeDto::Disabled => LanguageServerPreference::disabled(),
        LanguageServerModeDto::Enabled => LanguageServerPreference::enabled(),
    };
    if let Some(executable) = &config.executable {
        preference.with_explicit_executable(executable)
    } else {
        preference
    }
}

fn resolve_configuration(
    catalog: &LanguageServerCatalog,
    install_context: &InstallContext,
    dir_root: &Path,
) -> LanguageServiceConfiguration {
    let resolution = match catalog.resolve(
        install_context,
        // Initial roots are fixed by the trusted host; replacement roots reach this point only
        // after the App Server accepts the directory change.
        LanguageServerExecutionPolicy::Allowed,
        dir_root,
    ) {
        Ok(resolution) => resolution,
        Err(error) => {
            eprintln!("could not resolve language server catalog: {error}");
            return LanguageServiceConfiguration::disabled(dir_root);
        }
    };
    let definitions = resolution.into_definitions();
    if definitions.is_empty() {
        LanguageServiceConfiguration::disabled(dir_root)
    } else {
        LanguageServiceConfiguration::enabled(dir_root, definitions)
    }
}

fn language_document(
    dir_root: &Path,
    tab: &FileEditorTab,
) -> Result<LanguageServiceDocument, ash_lsp_manager::LanguageServiceError> {
    let path = if tab.path().is_absolute() {
        tab.path().to_path_buf()
    } else {
        dir_root.join(tab.path())
    };
    LanguageServiceDocument::new(
        path,
        language_id(tab.document().language()),
        LanguageDocumentRevision::new(tab.document().revision().value()),
        tab.document().text(),
    )
}

fn language_id(language: CodeEditorLanguage) -> &'static str {
    match language {
        CodeEditorLanguage::PlainText => "plaintext",
        CodeEditorLanguage::Shell => "shellscript",
        CodeEditorLanguage::Json => "json",
        CodeEditorLanguage::Jsonc => "jsonc",
        CodeEditorLanguage::Rust => "rust",
    }
}

#[cfg(test)]
#[path = "language_service_tests.rs"]
mod tests;
