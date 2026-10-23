use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use ash_async_utils::CancellationToken;
use ash_config::LanguageServerModeConfig;
use ash_config::LanguageServersConfig;
use ash_install_context::InstallContext;
use ash_lsp_manager::LanguageRequestId;
use ash_lsp_manager::LanguageRequestMetric;
use ash_lsp_manager::LanguageServerFeature;
use ash_lsp_manager::LanguageServerMessageSeverity;
use ash_lsp_manager::LanguageServerMessageSource;
use ash_lsp_manager::LanguageServerState;
use ash_lsp_manager::LspDocumentSnapshot;
use ash_lsp_manager::LspManager;
use ash_lsp_manager::LspManagerConfiguration;
use ash_lsp_manager::LspManagerEvent;
use ash_lsp_manager::LspManagerEventSink;
use ash_lsp_manager::LspManagerNotification;
use ash_lsp_manager::LspManagerRequestResult;
use ash_lsp_manager::LspRequestMetricsSink;
use ash_lsp_server_provider::BASH_LANGUAGE_SERVER_ID;
use ash_lsp_server_provider::JSON_LANGUAGE_SERVER_ID;
use ash_lsp_server_provider::LanguageServerAcquisition;
use ash_lsp_server_provider::LanguageServerExecutionPolicy;
use ash_lsp_server_provider::LanguageServerPreference;
use ash_lsp_server_provider::LspServerLaunch;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::LspServerResolver;
use ash_lsp_server_provider::ManagedLanguageServer;
use ash_lsp_server_provider::ManagedLanguageServerError;
use ash_lsp_server_provider::TYPESCRIPT_LANGUAGE_SERVER_ID;

use ash_app_server_protocol::protocol::language::LanguageDiagnosticsNotification;
use ash_app_server_protocol::protocol::language::LanguageServerMessageNotification;
use ash_app_server_protocol::protocol::language::LanguageServerMessageSeverityDto;
use ash_app_server_protocol::protocol::language::LanguageServerMessageSourceDto;
use ash_app_server_protocol::protocol::language::LanguageServerProgressNotification;
use ash_app_server_protocol::protocol::language::LanguageServerStateDto;
use ash_app_server_protocol::protocol::language::LanguageServerStateNotification;

use super::language_operations::diagnostic_to_dto;
use super::update_broker::UpdateBroker;

const SERVER_START_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

struct AppServerLanguageMetrics;

impl LspRequestMetricsSink for AppServerLanguageMetrics {
    fn record(&self, metric: LanguageRequestMetric) {
        log::debug!(
            target: "ash_lsp_manager",
            "request completed: kind={:?} server={} incarnation={} config_generation={} service_generation={} cold={} elapsed_ms={} results={} outcome={:?}",
            metric.kind,
            metric.server.as_deref().unwrap_or("none"),
            metric.server_incarnation.map_or_else(|| "none".into(), |value| value.to_string()),
            metric.configuration_generation,
            metric.service_generation,
            metric.cold_for_incarnation,
            metric.elapsed_millis,
            metric.result_count,
            metric.outcome,
        );
    }
}

struct AppServerLanguageEventSink {
    routes: Arc<std::sync::RwLock<BTreeMap<String, Vec<String>>>>,
    requests: Arc<LanguageRequestResults>,
    sources: Arc<Mutex<LanguageRuntimeSources>>,
    launch_versions: Arc<std::sync::RwLock<BTreeMap<String, u64>>>,
    active_versions: Mutex<BTreeMap<String, u64>>,
    sender: mpsc::Sender<LspManagerEvent>,
    diagnostics: Arc<LanguageDiagnosticPublisher>,
}

impl LspManagerEventSink for AppServerLanguageEventSink {
    fn on_request_queued(&self, id: LanguageRequestId) {
        self.requests.register(id);
    }

    fn on_request_abandoned(&self, id: LanguageRequestId) {
        self.requests.remove(id);
    }
    fn on_event(&self, event: LspManagerEvent) {
        if let LspManagerEvent::RequestResult(result) = event {
            self.requests.publish(result);
            return;
        }
        // Events already queued by a retiring incarnation must not republish diagnostics or
        // Ready after its source is disabled. Starting binds a replacement's source version.
        let server = match &event {
            LspManagerEvent::Notification(
                LspManagerNotification::ServerStateChanged { server, .. }
                | LspManagerNotification::ServerMessage { server, .. }
                | LspManagerNotification::DiagnosticsRefresh { server }
                | LspManagerNotification::CapabilitiesChanged { server, .. },
            ) => Some(server.clone()),
            LspManagerEvent::Notification(LspManagerNotification::ServerProgress(progress)) => {
                Some(progress.server.clone())
            }
            LspManagerEvent::Notification(LspManagerNotification::Diagnostics(diagnostics))
                if !diagnostics.diagnostics().is_empty() =>
            {
                let language = self
                    .diagnostics
                    .documents
                    .lock()
                    .ok()
                    .and_then(|documents| {
                        documents
                            .get(diagnostics.path())
                            .map(|snapshot| snapshot.language_id.clone())
                    });
                language.and_then(|language| {
                    self.routes
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .iter()
                        .find(|(_, languages)| languages.contains(&language))
                        .map(|(server, _)| server.clone())
                })
            }
            _ => None,
        };
        if server.is_none()
            && matches!(&event, LspManagerEvent::Notification(LspManagerNotification::Diagnostics(diagnostics)) if !diagnostics.diagnostics().is_empty())
        {
            return;
        }
        if let Some(server) = server {
            if matches!(
                &event,
                LspManagerEvent::Notification(LspManagerNotification::ServerStateChanged {
                    state: LanguageServerState::Starting,
                    ..
                })
            ) {
                let version = self
                    .launch_versions
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(&server)
                    .copied()
                    .unwrap_or(0);
                self.active_versions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(server.clone(), version);
            }
            let active = self
                .active_versions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&server)
                .copied()
                .unwrap_or(0);
            let current = self
                .sources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .versions
                .get(&server)
                .copied()
                .unwrap_or(0);
            if active != current
                && !matches!(
                    &event,
                    LspManagerEvent::Notification(LspManagerNotification::ServerStateChanged {
                        state: LanguageServerState::Stopped,
                        ..
                    })
                )
            {
                return;
            }
        }
        if let LspManagerEvent::Notification(LspManagerNotification::Diagnostics(diagnostics)) =
            &event
        {
            self.diagnostics.publish(diagnostics);
            return;
        }
        if let LspManagerEvent::Notification(LspManagerNotification::ServerMessage {
            server,
            severity,
            source,
            show,
            message,
        }) = &event
        {
            self.diagnostics.updates.publish_language_server_message(
                self.diagnostics.connection_id,
                LanguageServerMessageNotification {
                    dir_id: self.diagnostics.dir_id.clone(),
                    server: server.clone(),
                    severity: match severity {
                        LanguageServerMessageSeverity::Error => {
                            LanguageServerMessageSeverityDto::Error
                        }
                        LanguageServerMessageSeverity::Warning => {
                            LanguageServerMessageSeverityDto::Warning
                        }
                        LanguageServerMessageSeverity::Information => {
                            LanguageServerMessageSeverityDto::Information
                        }
                        LanguageServerMessageSeverity::Log => LanguageServerMessageSeverityDto::Log,
                    },
                    source: match source {
                        LanguageServerMessageSource::Protocol => {
                            LanguageServerMessageSourceDto::Protocol
                        }
                        LanguageServerMessageSource::Stderr => {
                            LanguageServerMessageSourceDto::Stderr
                        }
                        LanguageServerMessageSource::Service => {
                            LanguageServerMessageSourceDto::Service
                        }
                    },
                    show: *show,
                    message: message.clone(),
                },
            );
            return;
        }
        if let LspManagerEvent::Notification(LspManagerNotification::ServerProgress(progress)) =
            &event
        {
            self.diagnostics.updates.publish_language_server_progress(
                self.diagnostics.connection_id,
                LanguageServerProgressNotification {
                    dir_id: self.diagnostics.dir_id.clone(),
                    server: progress.server.clone(),
                    token: progress.token.clone(),
                    title: progress.title.clone(),
                    message: progress.message.clone(),
                    percentage: progress.percentage,
                    done: progress.done,
                },
            );
            return;
        }
        if let LspManagerEvent::Notification(LspManagerNotification::ServerStateChanged {
            server,
            state,
        }) = &event
        {
            self.diagnostics.updates.publish_language_server_state(
                self.diagnostics.connection_id,
                LanguageServerStateNotification {
                    dir_id: self.diagnostics.dir_id.clone(),
                    server: server.clone(),
                    state: language_server_state_to_dto(state),
                },
            );
        }
        if let LspManagerEvent::Notification(LspManagerNotification::DiagnosticsRefresh {
            server,
        }) = &event
        {
            self.diagnostics.updates.publish_language_diagnostics_refresh(
                self.diagnostics.connection_id,
                ash_app_server_protocol::protocol::language::LanguageDiagnosticsRefreshNotification {
                    dir_id: self.diagnostics.dir_id.clone(),
                    server: server.clone(),
                },
            );
            return;
        }
        if let LspManagerEvent::Notification(LspManagerNotification::CapabilitiesChanged {
            server,
            capabilities,
        }) = &event
        {
            self.diagnostics.updates.publish_language_server_capabilities(
                self.diagnostics.connection_id,
                ash_app_server_protocol::protocol::language::LanguageServerCapabilitiesNotification {
                    dir_id: self.diagnostics.dir_id.clone(), server: server.clone(),
                    language_ids: self.routes.read().unwrap_or_else(std::sync::PoisonError::into_inner).get(server).cloned().unwrap_or_default(),
                    features: capabilities.features.iter().map(|feature| match feature {
                        LanguageServerFeature::Hover => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Hover,
                        LanguageServerFeature::Completion => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Completion,
                        LanguageServerFeature::CompletionResolve => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CompletionResolve,
                        LanguageServerFeature::ExecuteCommand => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::ExecuteCommand,
                        LanguageServerFeature::Declaration => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Declaration,
                        LanguageServerFeature::Definition => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Definition,
                        LanguageServerFeature::Implementation => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Implementation,
                        LanguageServerFeature::TypeDefinition => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::TypeDefinition,
                        LanguageServerFeature::References => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::References,
                        LanguageServerFeature::CallHierarchy => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CallHierarchy,
                        LanguageServerFeature::TypeHierarchy => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::TypeHierarchy,
                        LanguageServerFeature::WorkspaceSymbols => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::WorkspaceSymbols,
                        LanguageServerFeature::Rename => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::Rename,
                        LanguageServerFeature::RenamePrepare => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::RenamePrepare,
                        LanguageServerFeature::CodeActions => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CodeActions,
                        LanguageServerFeature::CodeActionResolve => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CodeActionResolve,
                        LanguageServerFeature::DocumentFormatting => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentFormatting,
                        LanguageServerFeature::RangeFormatting => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::RangeFormatting,
                        LanguageServerFeature::OnTypeFormatting => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::OnTypeFormatting,
                        LanguageServerFeature::SignatureHelp => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::SignatureHelp,
                        LanguageServerFeature::InlayHints => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::InlayHints,
                        LanguageServerFeature::LinkedEditingRanges => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::LinkedEditingRanges,
                        LanguageServerFeature::SemanticTokens => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::SemanticTokens,
                        LanguageServerFeature::DocumentSymbols => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentSymbols,
                        LanguageServerFeature::CodeLens => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CodeLens,
                        LanguageServerFeature::CodeLensResolve => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CodeLensResolve,
                        LanguageServerFeature::DocumentLinks => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentLinks,
                        LanguageServerFeature::DocumentLinkResolve => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentLinkResolve,
                        LanguageServerFeature::DocumentColors => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentColors,
                        LanguageServerFeature::FoldingRanges => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::FoldingRanges,
                        LanguageServerFeature::PullDiagnostics => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::PullDiagnostics,
                        LanguageServerFeature::WorkspaceDiagnostics => ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::WorkspaceDiagnostics,
                    }).collect(),
                    completion_trigger_characters: capabilities.completion_trigger_characters.clone(),
                    on_type_formatting_trigger_characters: capabilities.on_type_formatting_trigger_characters.clone(),
                    signature_help_trigger_characters: capabilities.signature_help_trigger_characters.clone(),
                    signature_help_retrigger_characters: capabilities.signature_help_retrigger_characters.clone(),
                },
            );
        }
        let _ = self.sender.send(event);
    }
}

pub(super) fn language_server_state_to_dto(state: &LanguageServerState) -> LanguageServerStateDto {
    match state {
        LanguageServerState::Starting => LanguageServerStateDto::Starting,
        LanguageServerState::Ready => LanguageServerStateDto::Ready,
        LanguageServerState::BackingOff {
            attempt,
            retry_after,
        } => LanguageServerStateDto::BackingOff {
            attempt: *attempt,
            retry_after_millis: retry_after.as_millis().min(u128::from(u64::MAX)) as u64,
        },
        LanguageServerState::CrashLoop {
            restart_attempts,
            message,
        } => LanguageServerStateDto::CrashLoop {
            restart_attempts: *restart_attempts,
            message: message.clone(),
        },
        LanguageServerState::Failed(message) => LanguageServerStateDto::Failed {
            message: message.clone(),
        },
        LanguageServerState::Stopped | LanguageServerState::UserStopped => {
            LanguageServerStateDto::Stopped
        }
    }
}

#[derive(Clone)]
struct AppServerLanguageDocumentSnapshot {
    relative_path: PathBuf,
    language_id: String,
    revision: ash_lsp_manager::LanguageDocumentRevision,
    text: String,
}

struct LanguageDiagnosticPublisher {
    documents: Arc<Mutex<BTreeMap<PathBuf, AppServerLanguageDocumentSnapshot>>>,
    updates: Arc<UpdateBroker>,
    dir_id: Option<String>,
    connection_id: Option<u64>,
}

impl LanguageDiagnosticPublisher {
    fn publish(&self, diagnostics: &ash_lsp_manager::LanguageDiagnostics) {
        let snapshot = self
            .documents
            .lock()
            .ok()
            .and_then(|documents| documents.get(diagnostics.path()).cloned());
        let Some(snapshot) =
            snapshot.filter(|snapshot| snapshot.revision == diagnostics.revision())
        else {
            return;
        };
        let diagnostics = diagnostics
            .diagnostics()
            .iter()
            .cloned()
            .filter_map(|diagnostic| diagnostic_to_dto(&snapshot.text, diagnostic))
            .collect();
        self.updates.publish_language_diagnostics(
            self.connection_id,
            LanguageDiagnosticsNotification {
                dir_id: self.dir_id.clone(),
                path: snapshot.relative_path,
                revision: snapshot.revision.value(),
                diagnostics,
            },
        );
    }
}

struct AppServerLanguageDirState {
    documents: Arc<Mutex<BTreeMap<PathBuf, AppServerLanguageDocumentSnapshot>>>,
    root: Option<PathBuf>,
    language_servers: BTreeMap<String, String>,
    server_states: BTreeMap<String, LanguageServerState>,
    dir_id: Option<String>,
    settings: BTreeMap<String, serde_json::Value>,
}

impl Default for AppServerLanguageDirState {
    fn default() -> Self {
        Self {
            documents: Arc::new(Mutex::new(BTreeMap::new())),
            root: None,
            language_servers: BTreeMap::new(),
            server_states: BTreeMap::new(),
            dir_id: None,
            settings: BTreeMap::new(),
        }
    }
}

/// Source changes and session retirement are serialized here; no process I/O or request wait
/// holds this lock. Per-server versions also reject responses completed just before revocation.
#[derive(Default)]
struct LanguageRuntimeSources {
    providers: LspServerProviders,
    acquisitions: BTreeMap<String, LanguageServerAcquisition>,
    configuration: Option<LanguageServersConfig>,
    versions: BTreeMap<String, u64>,
    sessions: Vec<std::sync::Weak<LanguageSession>>,
    retained_roots: Option<std::collections::BTreeSet<PathBuf>>,
}

impl LanguageRuntimeSources {
    fn retire(&mut self, names: Vec<String>) {
        if names.is_empty() {
            return;
        }
        for name in &names {
            let version = self.versions.entry(name.clone()).or_default();
            *version = version.saturating_add(1);
        }
        self.sessions.retain(|session| {
            if let Some(session) = session.upgrade() {
                session
                    .routes
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .retain(|id, _| !names.contains(id));
                let _ = session.manager.retire_servers(names.clone());
                session
                    .acquired
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .retain(|id, _| !names.contains(id));
                true
            } else {
                false
            }
        });
    }
}

#[derive(Default)]
struct LanguageRequestResults {
    // Registration happens before queueing, so even a synchronous rejection has a receiver.
    requests: Mutex<
        BTreeMap<
            LanguageRequestId,
            (
                mpsc::Sender<LspManagerRequestResult>,
                Option<mpsc::Receiver<LspManagerRequestResult>>,
            ),
        >,
    >,
}

impl LanguageRequestResults {
    fn register(&self, id: LanguageRequestId) {
        let (sender, receiver) = mpsc::channel();
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, (sender, Some(receiver)));
    }

    fn publish(&self, result: LspManagerRequestResult) {
        if let Some((sender, _)) = self
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&result.request_id())
        {
            let _ = sender.send(result);
        }
    }

    fn take(
        &self,
        id: LanguageRequestId,
    ) -> Result<mpsc::Receiver<LspManagerRequestResult>, String> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(&id)
            .and_then(|(_, receiver)| receiver.take())
            .ok_or_else(|| "language request has no result destination".into())
    }

    fn remove(&self, id: LanguageRequestId) {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
    }
}

type AcquiredLanguageServers = Arc<Mutex<BTreeMap<String, ManagedLanguageServer>>>;

struct LanguageSession {
    acquired: AcquiredLanguageServers,
    manager: Arc<LspManager>,
    requests: Arc<LanguageRequestResults>,
    routes: Arc<std::sync::RwLock<BTreeMap<String, Vec<String>>>>,
    launch_versions: Arc<std::sync::RwLock<BTreeMap<String, u64>>>,
    root: PathBuf,
    connection_id: Option<u64>,
    cancellation: ash_async_utils::CancellationSource,
}

struct LanguageConnection {
    runtime: Arc<tokio::sync::Mutex<AppServerLanguageRuntime>>,
    cancellation: ash_async_utils::CancellationSource,
}

/// Holds only one client's short mutation phase. Request waiting consumes this guard and keeps
/// its own result channel, so neither other clients nor retirement need to wait for its reply.
pub(super) struct LanguageRuntimeGuard {
    runtime: tokio::sync::OwnedMutexGuard<AppServerLanguageRuntime>,
    connection: Arc<LanguageConnection>,
}

impl LanguageRuntimeGuard {
    pub(super) fn new(
        mut runtime: std::sync::MutexGuard<'_, AppServerLanguageRuntime>,
        connection_id: u64,
    ) -> Self {
        if !runtime.connections.contains_key(&connection_id) {
            let mut child = runtime.child_runtime();
            child.connection_id = Some(connection_id);
            let cancellation = ash_async_utils::CancellationSource::new();
            child.connection_cancellation = Some(cancellation.token());
            runtime.connections.insert(
                connection_id,
                Arc::new(LanguageConnection {
                    runtime: Arc::new(tokio::sync::Mutex::new(child)),
                    cancellation,
                }),
            );
        }
        let connection = runtime.connections[&connection_id].clone();
        drop(runtime);
        let mut runtime = pollster::block_on(Arc::clone(&connection.runtime).lock_owned());
        runtime.refresh_sources();
        Self {
            runtime,
            connection,
        }
    }

    pub(super) fn wait_for_request(
        self,
        request_id: LanguageRequestId,
        cancellation: &CancellationToken,
    ) -> Result<LspManagerRequestResult, String> {
        let runtime = self.selected_runtime();
        let session = runtime
            .session
            .clone()
            .ok_or_else(|| "language session is unavailable".to_owned())?;
        let server = runtime
            .active_language_id
            .as_ref()
            .and_then(|language| runtime.dir_state.language_servers.get(language))
            .cloned()
            .ok_or_else(|| "language route is unavailable".to_owned())?;
        let version = runtime.source_versions.get(&server).copied().unwrap_or(0);
        let sources = Arc::clone(&runtime.sources);
        let receiver = session.requests.take(request_id)?;
        let connection_cancellation = self.connection.cancellation.token();
        drop(self);
        let wait = || {
            let deadline = Instant::now() + REQUEST_TIMEOUT;
            loop {
                if cancellation.is_cancelled()
                    || connection_cancellation.is_cancelled()
                    || session.cancellation.token().is_cancelled()
                {
                    return Err("language request cancelled".into());
                }
                let current = sources
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .versions
                    .get(&server)
                    .copied()
                    .unwrap_or(0);
                if current != version {
                    return Err("language server source was retired".into());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("language service request timed out".into());
                }
                match receiver.recv_timeout(remaining.min(Duration::from_millis(25))) {
                    Ok(result) => {
                        let current = sources
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .versions
                            .get(&server)
                            .copied()
                            .unwrap_or(0);
                        if current != version {
                            return Err("language server source was retired".into());
                        }
                        return Ok(result);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("language service event channel is unavailable".into());
                    }
                }
            }
        };
        let result = wait();
        session.requests.remove(request_id);
        if result.is_err() {
            let _ = session.manager.cancel_request(request_id);
        }
        result
    }
}

impl std::ops::Deref for LanguageRuntimeGuard {
    type Target = AppServerLanguageRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl std::ops::DerefMut for LanguageRuntimeGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}

pub(super) struct AppServerLanguageRuntime {
    pub(super) manager: Option<Arc<LspManager>>,
    receiver: Option<mpsc::Receiver<LspManagerEvent>>,
    updates: Arc<UpdateBroker>,
    dir_state: AppServerLanguageDirState,
    providers: LspServerProviders,
    env_runtimes: BTreeMap<PathBuf, Box<AppServerLanguageRuntime>>,
    active_dir_root: Option<PathBuf>,
    home: Option<PathBuf>,
    network_policy: ash_http_client::OutboundNetworkPolicy,
    extension_generation: Option<(u64, u64)>,
    connections: BTreeMap<u64, Arc<LanguageConnection>>,
    connection_id: Option<u64>,
    acquisitions: BTreeMap<String, LanguageServerAcquisition>,
    acquired: AcquiredLanguageServers,
    sources: Arc<Mutex<LanguageRuntimeSources>>,
    source_versions: BTreeMap<String, u64>,
    session: Option<Arc<LanguageSession>>,
    definitions_dirty: bool,
    active_language_id: Option<String>,
    connection_cancellation: Option<CancellationToken>,
}

impl AppServerLanguageRuntime {
    pub(super) fn new(updates: Arc<UpdateBroker>) -> Self {
        Self {
            manager: None,
            receiver: None,
            updates,
            dir_state: AppServerLanguageDirState::default(),
            providers: LspServerProviders::new(),
            env_runtimes: BTreeMap::new(),
            active_dir_root: None,
            home: None,
            network_policy: ash_http_client::OutboundNetworkPolicy::default(),
            extension_generation: None,
            connections: BTreeMap::new(),
            connection_id: None,
            acquisitions: BTreeMap::new(),
            acquired: Arc::new(Mutex::new(BTreeMap::new())),
            sources: Arc::new(Mutex::new(LanguageRuntimeSources::default())),
            source_versions: BTreeMap::new(),
            session: None,
            definitions_dirty: false,
            active_language_id: None,
            connection_cancellation: None,
        }
    }

    fn child_runtime(&self) -> Self {
        let mut runtime = Self::new(Arc::clone(&self.updates));
        runtime.sources = Arc::clone(&self.sources);
        runtime.source_versions = self.source_versions.clone();
        runtime.connection_cancellation = self.connection_cancellation.clone();
        runtime.providers = self.providers.clone();
        runtime.acquisitions = self.acquisitions.clone();
        runtime.extension_generation = self.extension_generation;
        runtime.home = self.home.clone();
        runtime.network_policy = self.network_policy.clone();
        runtime.connection_id = self.connection_id;
        runtime
    }

    fn selected_runtime(&self) -> &Self {
        self.active_dir_root
            .as_ref()
            .and_then(|root| self.env_runtimes.get(root))
            .map_or(self, |runtime| runtime.selected_runtime())
    }

    fn refresh_sources(&mut self) {
        let (providers, acquisitions, versions, retained_roots) = {
            let sources = self
                .sources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                sources.providers.clone(),
                sources.acquisitions.clone(),
                sources.versions.clone(),
                sources.retained_roots.clone(),
            )
        };
        let changed_names = self
            .source_versions
            .keys()
            .chain(versions.keys())
            .filter(|id| self.source_versions.get(*id) != versions.get(*id))
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let changed = !changed_names.is_empty();
        if let Some(receiver) = &self.receiver {
            let events = receiver.try_iter().collect::<Vec<_>>();
            for event in events {
                if !matches!(&event, LspManagerEvent::Notification(LspManagerNotification::ServerStateChanged { server, .. }) if changed_names.contains(server))
                {
                    self.accept_state(&event);
                }
            }
        }
        self.dir_state
            .server_states
            .retain(|id, _| !changed_names.contains(id));
        self.acquired
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|id, _| self.source_versions.get(id) == versions.get(id));
        self.providers = providers;
        self.acquisitions = acquisitions;
        self.source_versions = versions;
        self.definitions_dirty |= changed;
        if let Some(roots) = retained_roots {
            self.env_runtimes.retain(|root, _| roots.contains(root));
            if self
                .dir_state
                .root
                .as_ref()
                .is_some_and(|root| !roots.contains(root))
            {
                self.shutdown_selected();
            }
        }
        for runtime in self.env_runtimes.values_mut() {
            runtime.refresh_sources();
        }
    }

    pub(super) fn reconcile_configuration(&mut self, configuration: &LanguageServersConfig) {
        let mut sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if sources.configuration.as_ref() != Some(configuration) {
            let old = sources.configuration.as_ref().map(|config| &config.servers);
            let ids = old
                .into_iter()
                .flat_map(|servers| servers.keys())
                .chain(configuration.servers.keys())
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            let changed = ids
                .into_iter()
                .filter(|id| {
                    old.and_then(|servers| servers.get(id)) != configuration.servers.get(id)
                })
                .map(|id| id.to_string())
                .collect();
            sources.configuration = Some(configuration.clone());
            sources.retire(changed);
        }
        drop(sources);
        self.refresh_sources();
    }

    pub(super) fn close_connection(&mut self, connection_id: u64) {
        if let Some(connection) = self.connections.remove(&connection_id) {
            connection.cancellation.cancel();
        }
        let sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for session in sources
            .sessions
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .filter(|session| session.connection_id == Some(connection_id))
        {
            session.cancellation.cancel();
            let _ = session
                .manager
                .set_enablement(ash_lsp_manager::LspManagerEnablement::Disabled);
        }
    }

    pub(super) fn set_server_providers(&mut self, providers: LspServerProviders) {
        let mut sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let ids = sources
            .providers
            .ids()
            .chain(providers.ids())
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>();
        let changed: Vec<String> = ids
            .into_iter()
            .filter(|id| !sources.providers.same_provider(&providers, id))
            .collect();
        sources.providers = providers;
        if let Some(manager) = &self.manager {
            let _ = manager.retire_servers(changed.clone());
        }
        sources.retire(changed);
        drop(sources);
        self.refresh_sources();
    }

    pub(super) fn set_home(&mut self, home: &Path) {
        self.home = Some(home.to_path_buf());
    }

    pub(super) fn set_network_policy(&mut self, policy: ash_http_client::OutboundNetworkPolicy) {
        self.network_policy = policy;
    }

    /// Reconcile the existing frozen extension catalog before language operations. Revocation
    /// retires processes and leases before any request can reuse the previous contribution.
    pub(super) fn reconcile_extensions(
        &mut self,
        snapshot: &ash_external_ext::packages::ExtensionPackagesSnapshot,
        policy: Option<&ash_core_plugins::EditorExtensionPolicy>,
    ) -> Result<(), String> {
        let generation = (
            snapshot.generation,
            policy.map_or(0, |policy| policy.generation()),
        );
        if self.extension_generation == Some(generation) {
            return Ok(());
        }
        let contributions =
            super::extension_packages_language_runtime::language_server_contributions(snapshot)?;
        let acquisitions = contributions
            .into_iter()
            .filter(|(id, _)| policy.is_none_or(|policy| policy.is_extension_enabled(id)))
            .flat_map(|(_, servers)| {
                servers
                    .into_iter()
                    .map(|server| (server.id.clone(), server))
            })
            .collect();
        let mut sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let acquisitions: BTreeMap<String, LanguageServerAcquisition> = acquisitions;
        let ids = sources
            .acquisitions
            .keys()
            .chain(acquisitions.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let changed = ids
            .into_iter()
            .filter(
                |id| match (sources.acquisitions.get(id), acquisitions.get(id)) {
                    (Some(old), Some(new)) => !old.same_policy(new),
                    (None, None) => false,
                    _ => true,
                },
            )
            .collect();
        sources.acquisitions = acquisitions;
        sources.retire(changed);
        drop(sources);
        self.refresh_sources();
        self.extension_generation = Some(generation);
        Ok(())
    }

    pub(super) fn acquisitions<'a>(
        &'a self,
        configuration: &'a LanguageServersConfig,
    ) -> impl Iterator<Item = &'a LanguageServerAcquisition> {
        self.acquisitions.values().filter(move |server| {
            !self.providers.contains(&server.id)
                && configuration
                    .servers
                    .iter()
                    .find(|(id, _)| id.as_str() == server.id)
                    .is_none_or(|(_, config)| config.mode == LanguageServerModeConfig::Enabled)
        })
    }

    /// Drains the supervisor's existing lifecycle projection without starting a process.
    pub(super) fn server_states(&mut self, root: &Path) -> BTreeMap<String, LanguageServerState> {
        if self
            .dir_state
            .root
            .as_deref()
            .is_some_and(|current| current != root)
        {
            return self
                .env_runtimes
                .get_mut(root)
                .map_or_else(BTreeMap::new, |runtime| runtime.server_states(root));
        }
        let events = self
            .receiver
            .as_ref()
            .map(|receiver| receiver.try_iter().collect::<Vec<_>>())
            .unwrap_or_default();
        for event in events {
            self.accept_state(&event);
        }
        self.dir_state.server_states.clone()
    }

    pub(super) fn control_servers(
        &mut self,
        root: &Path,
        dir_id: Option<&str>,
        generation: u64,
        configuration: &LanguageServersConfig,
        target: Option<(&str, &str)>,
        action: ash_lsp_manager::LanguageServerControl,
    ) -> Result<(), String> {
        if self.env_runtimes.contains_key(root)
            || self
                .dir_state
                .root
                .as_deref()
                .is_some_and(|current| current != root)
        {
            if !self.env_runtimes.contains_key(root) {
                if action == ash_lsp_manager::LanguageServerControl::Stop {
                    return Ok(());
                }
                let child = self.child_runtime();
                self.env_runtimes
                    .insert(root.to_path_buf(), Box::new(child));
            }
            return self
                .env_runtimes
                .get_mut(root)
                .expect("directory runtime")
                .control_servers(root, dir_id, generation, configuration, target, action);
        }
        let states = self.server_states(root);
        self.dir_state.dir_id = dir_id.map(str::to_owned);
        if let Some((id, language)) = target
            && !states.contains_key(id)
            && action == ash_lsp_manager::LanguageServerControl::Restart
        {
            // Starting an idle declaration is explicit intent. Batch controls never acquire
            // unused tools merely because they appear in discovery.
            return self.restart_selected(root, generation, configuration, language, Some(id));
        }
        let Some(manager) = &self.manager else {
            return Ok(());
        };
        let names = states
            .keys()
            .filter(|id| target.is_none_or(|(target, _)| target == id.as_str()))
            .map(|id| ash_lsp_manager::LanguageServerName::new(id.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        manager
            .control_servers(action, names)
            .map_err(|error| error.to_string())
    }

    /// Background pulls may activate a declared workspace kind, but not install servers in
    /// unrelated folders merely because the client enumerates every available language.
    pub(super) fn allows_workspace_diagnostics(
        &self,
        root: &Path,
        language: &str,
        configuration: &LanguageServersConfig,
    ) -> bool {
        let active = if self.dir_state.root.as_deref() == Some(root) {
            Some(self)
        } else {
            self.env_runtimes.get(root).map(Box::as_ref)
        };
        self.acquisitions(configuration)
            .filter(|server| server.languages.iter().any(|id| id == language))
            .all(|server| {
                active.is_some_and(|runtime| {
                    runtime
                        .acquired
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .contains_key(&server.id)
                }) || server
                    .workspace_files
                    .iter()
                    .any(|file| root.join(file).is_file())
            })
    }

    pub(super) fn server_running(&self, id: &str) -> bool {
        let sessions = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sessions
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .collect::<Vec<_>>();
        self.acquired
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(id)
            || sessions.iter().any(|session| {
                session
                    .routes
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .contains_key(id)
                    && !session.cancellation.token().is_cancelled()
            })
            || self
                .env_runtimes
                .values()
                .any(|runtime| runtime.server_running(id))
    }

    pub(super) fn invalidate_extensions(&mut self) {
        self.extension_generation = None;
    }

    pub(super) fn reset_dirs(&mut self) {
        self.shutdown();
        // The directory owner has replaced the whole grant set. Requests already holding the
        // old set are cancelled above; new requests must resolve against the new authority.
        self.sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retained_roots = None;
    }

    pub(super) fn retain_dir_roots(&mut self, roots: &std::collections::BTreeSet<PathBuf>) {
        let mut sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sources.retained_roots = Some(roots.clone());
        for session in sources
            .sessions
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .filter(|session| !roots.contains(&session.root))
        {
            session.cancellation.cancel();
            let _ = session
                .manager
                .set_enablement(ash_lsp_manager::LspManagerEnablement::Disabled);
        }
        drop(sources);
        self.refresh_sources();
    }

    /// Keeps each renderer's effective settings with its directory's language session.
    pub(super) fn configure_workspace_settings(
        &mut self,
        dir_root: &Path,
        settings: BTreeMap<String, serde_json::Value>,
    ) {
        if self.env_runtimes.contains_key(dir_root)
            || self
                .dir_state
                .root
                .as_deref()
                .is_some_and(|root| root != dir_root)
        {
            if !self.env_runtimes.contains_key(dir_root) {
                let runtime = self.child_runtime();
                self.env_runtimes
                    .insert(dir_root.to_path_buf(), Box::new(runtime));
            }
            self.env_runtimes
                .get_mut(dir_root)
                .expect("directory runtime")
                .configure_workspace_settings(dir_root, settings);
            return;
        }
        if self.dir_state.root.is_none() || self.dir_state.settings != settings {
            let changed = self
                .dir_state
                .settings
                .keys()
                .chain(settings.keys())
                .filter(|name| self.dir_state.settings.get(*name) != settings.get(*name))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            // Retire before replacement even if an override equals the profile value.
            // Otherwise the old Ready state can admit requests during initialization.
            if let Some(manager) = &self.manager {
                let _ = manager.retire_servers(changed.iter().cloned().collect());
            }
            self.dir_state
                .server_states
                .retain(|name, _| !changed.contains(name));
            self.dir_state.root = Some(dir_root.to_path_buf());
            self.dir_state.settings = settings;
            self.definitions_dirty = true;
        }
    }

    pub(super) fn ensure(
        &mut self,
        dir_root: &Path,
        dir_id: Option<&str>,
        config_generation: u64,
        configuration: &LanguageServersConfig,
        language_id: &str,
    ) -> Result<&LspManager, String> {
        if self.env_runtimes.contains_key(dir_root)
            || (self.dir_state.root.is_some() && self.dir_state.root.as_deref() != Some(dir_root))
        {
            self.active_dir_root = Some(dir_root.to_path_buf());
            if !self.env_runtimes.contains_key(dir_root) {
                let runtime = self.child_runtime();
                self.env_runtimes
                    .insert(dir_root.to_path_buf(), Box::new(runtime));
            }
            let runtime = self
                .env_runtimes
                .get_mut(dir_root)
                .expect("directory session exists");
            return runtime.ensure(
                dir_root,
                dir_id,
                config_generation,
                configuration,
                language_id,
            );
        }
        self.active_dir_root = None;
        self.active_language_id = Some(language_id.to_owned());
        self.dir_state.dir_id = dir_id.map(str::to_owned);
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.cancellation.token().is_cancelled())
        {
            self.shutdown_selected();
        }
        if self.manager.is_none()
            || self.dir_state.root.as_deref() != Some(dir_root)
            || self.definitions_dirty
            || !self.dir_state.language_servers.contains_key(language_id)
            || self.acquisitions(configuration).any(|server| {
                server.languages.iter().any(|id| id == language_id)
                    && !self
                        .acquired
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .contains_key(&server.id)
            })
        {
            self.restart(dir_root, config_generation, configuration, language_id)?;
        }
        self.wait_until_ready(language_id)?;
        self.manager
            .as_deref()
            .ok_or_else(|| "language service is unavailable".into())
    }

    pub(super) fn manager(&self) -> Option<&LspManager> {
        match &self.active_dir_root {
            Some(root) => self
                .env_runtimes
                .get(root)
                .and_then(|runtime| runtime.manager()),
            None => self.manager.as_deref(),
        }
    }

    pub(super) fn synchronize_document(
        &mut self,
        dir_root: &Path,
        dir_id: Option<&str>,
        config_generation: u64,
        configuration: &LanguageServersConfig,
        relative_path: &Path,
        document: LspDocumentSnapshot,
    ) -> Result<(), String> {
        let language_id = document.language_id().to_owned();
        self.ensure(
            dir_root,
            dir_id,
            config_generation,
            configuration,
            &language_id,
        )?;
        if let Some(root) = self.active_dir_root.clone() {
            return self
                .env_runtimes
                .get_mut(&root)
                .ok_or_else(|| String::from("language directory runtime is unavailable"))?
                .synchronize_selected_document(relative_path, document);
        }
        self.synchronize_selected_document(relative_path, document)
    }

    fn synchronize_selected_document(
        &mut self,
        relative_path: &Path,
        document: LspDocumentSnapshot,
    ) -> Result<(), String> {
        self.dir_state
            .documents
            .lock()
            .map_err(|_| String::from("language document snapshots are unavailable"))?
            .insert(
                document.path().to_path_buf(),
                AppServerLanguageDocumentSnapshot {
                    relative_path: relative_path.to_path_buf(),
                    language_id: document.language_id().to_owned(),
                    revision: document.revision(),
                    text: document.text().to_owned(),
                },
            );
        self.manager
            .as_ref()
            .ok_or_else(|| String::from("language service is unavailable"))?
            .synchronize_document(document)
            .map_err(|error| error.to_string())
    }

    pub(super) fn save_document(
        &mut self,
        root: &Path,
        path: &Path,
        text: String,
    ) -> Result<(), String> {
        if self.dir_state.root.as_deref() != Some(root) {
            return self
                .env_runtimes
                .get_mut(root)
                .ok_or_else(|| "language directory runtime is unavailable".to_owned())?
                .save_document(root, path, text);
        }
        self.manager
            .as_ref()
            .ok_or_else(|| "language service is unavailable".to_owned())?
            .save_document(path, text)
            .map_err(|error| error.to_string())
    }

    pub(super) fn close_document(&mut self, dir_root: &Path, path: &Path) -> Result<(), String> {
        if self.dir_state.root.as_deref() != Some(dir_root) {
            return self
                .env_runtimes
                .get_mut(dir_root)
                .map_or(Ok(()), |runtime| runtime.close_selected_document(path));
        }
        self.close_selected_document(path)
    }

    fn close_selected_document(&mut self, path: &Path) -> Result<(), String> {
        self.dir_state
            .documents
            .lock()
            .map_err(|_| String::from("language document snapshots are unavailable"))?
            .remove(path);
        if let Some(manager) = &self.manager {
            manager
                .close_document(path)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(super) fn definitions(
        &self,
        dir_root: &Path,
        configuration: &LanguageServersConfig,
    ) -> Result<Vec<ash_lsp_manager::LanguageServerDefinition>, String> {
        if let Some(runtime) = self.env_runtimes.get(dir_root) {
            return runtime.definitions(dir_root, configuration);
        }
        let builtin = |id| {
            if self.providers.contains(id) {
                LanguageServerPreference::disabled()
            } else {
                preference(configuration, id)
            }
        };
        // Extension-owned servers are advertised without executing their acquisition recipes.
        let resolver = LspServerResolver::disabled()
            .with_json_language_server(builtin(JSON_LANGUAGE_SERVER_ID))
            .with_bash_language_server(builtin(BASH_LANGUAGE_SERVER_ID))
            .with_typescript_language_server(builtin(TYPESCRIPT_LANGUAGE_SERVER_ID));
        let resolution = resolver
            .resolve(
                &InstallContext::current(),
                LanguageServerExecutionPolicy::Allowed,
                dir_root,
            )
            .map_err(|error| error.to_string())?;
        let mut definitions = resolution.into_definitions();
        definitions.extend(configured_provider_definitions(
            &self.providers,
            configuration,
            dir_root,
        )?);
        for (id, config) in &configuration.servers {
            if config.mode == LanguageServerModeConfig::Disabled
                || config.language_ids.is_empty()
                || definitions
                    .iter()
                    .any(|definition| definition.name().as_str() == id.as_str())
                || self.acquisitions.contains_key(id.as_str())
            {
                continue;
            }
            if let Some(executable) = &config.executable {
                match ash_lsp_server_provider::resolve_executable(
                    id.as_str(),
                    &config.language_ids,
                    executable,
                    dir_root,
                ) {
                    Ok(definition) => definitions.push(definition),
                    Err(error) => log::warn!("language server {id} is unavailable: {error}"),
                }
            }
        }
        Ok(definitions
            .into_iter()
            .filter_map(|definition| {
                let id = definition.name().to_string();
                match configure_definition(definition, configuration, &self.dir_state.settings) {
                    Ok(definition) => Some(definition),
                    Err(error) => {
                        log::warn!("language server {id} is unavailable: {error}");
                        None
                    }
                }
            })
            .collect())
    }

    fn restart(
        &mut self,
        dir_root: &Path,
        config_generation: u64,
        configuration: &LanguageServersConfig,
        language_id: &str,
    ) -> Result<(), String> {
        self.restart_selected(
            dir_root,
            config_generation,
            configuration,
            language_id,
            None,
        )
    }

    fn restart_selected(
        &mut self,
        dir_root: &Path,
        config_generation: u64,
        configuration: &LanguageServersConfig,
        language_id: &str,
        selected: Option<&str>,
    ) -> Result<(), String> {
        let needed = self
            .acquisitions(configuration)
            .filter(|server| {
                server.languages.iter().any(|id| id == language_id)
                    && !self
                        .acquired
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .contains_key(&server.id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for server in needed {
            if let Ok(resolved) = self.resolve_server(&server, dir_root, configuration) {
                self.acquired
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(server.id.clone(), resolved);
            }
        }
        let mut definitions = self.definitions(dir_root, configuration)?;
        for server in self
            .acquired
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            definitions.push(configure_definition(
                server.definition().clone(),
                configuration,
                &self.dir_state.settings,
            )?);
        }
        if let Some(selected) = selected {
            // An explicit single-server start must not activate other idle declarations.
            // Keep every existing route, including user-stopped definitions.
            definitions.retain(|definition| {
                definition.name().as_str() == selected
                    || self
                        .dir_state
                        .language_servers
                        .values()
                        .any(|id| id == definition.name().as_str())
            });
        }
        // Selection can perform process/network I/O. Recheck its source while registering the
        // manager, so a concurrent disable or uninstall cannot launch a retired recipe.
        let mut sources = self
            .sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self
            .connection_cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
            || sources
                .retained_roots
                .as_ref()
                .is_some_and(|roots| !roots.contains(dir_root))
            || definitions.iter().any(|definition| {
                sources.versions.get(definition.name().as_str())
                    != self.source_versions.get(definition.name().as_str())
            })
        {
            return Err("language server source was retired during resolution".into());
        }
        self.dir_state.language_servers = definitions
            .iter()
            .flat_map(|definition| {
                let server = definition.name().to_string();
                definition
                    .language_ids()
                    .map(move |language| (language.to_owned(), server.clone()))
            })
            .collect();
        if definitions.is_empty() {
            return Err("no configured language-server executable is available".into());
        }
        let routes: BTreeMap<String, Vec<String>> = definitions
            .iter()
            .map(|definition| {
                (
                    definition.name().as_str().to_owned(),
                    definition.language_ids().map(str::to_owned).collect(),
                )
            })
            .collect();
        if let Some(session) = &self.session {
            *session
                .launch_versions
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = self.source_versions.clone();
            *session
                .routes
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = routes;
            session
                .manager
                .replace_servers(definitions, config_generation)
                .map_err(|error| error.to_string())?;
        } else {
            let (sender, receiver) = mpsc::channel();
            let requests = Arc::new(LanguageRequestResults::default());
            let routes = Arc::new(std::sync::RwLock::new(routes));
            let launch_versions = Arc::new(std::sync::RwLock::new(self.source_versions.clone()));
            let manager = Arc::new(
                LspManager::start_with_events_and_metrics(
                    LspManagerConfiguration::enabled(dir_root, definitions)
                        .with_generation(config_generation),
                    Arc::new(AppServerLanguageEventSink {
                        routes: Arc::clone(&routes),
                        requests: Arc::clone(&requests),
                        sender,
                        sources: Arc::clone(&self.sources),
                        launch_versions: Arc::clone(&launch_versions),
                        active_versions: Mutex::new(self.source_versions.clone()),
                        diagnostics: Arc::new(LanguageDiagnosticPublisher {
                            documents: Arc::clone(&self.dir_state.documents),
                            updates: Arc::clone(&self.updates),
                            dir_id: self.dir_state.dir_id.clone(),
                            connection_id: self.connection_id,
                        }),
                    }),
                    Arc::new(AppServerLanguageMetrics),
                )
                .map_err(|error| error.to_string())?,
            );
            let session = Arc::new(LanguageSession {
                acquired: Arc::clone(&self.acquired),
                manager: Arc::clone(&manager),
                requests,
                routes,
                launch_versions,
                root: dir_root.to_path_buf(),
                connection_id: self.connection_id,
                cancellation: ash_async_utils::CancellationSource::new(),
            });
            sources
                .sessions
                .retain(|session| session.strong_count() > 0);
            sources.sessions.push(Arc::downgrade(&session));
            self.session = Some(session);
            self.manager = Some(manager);
            self.receiver = Some(receiver);
        }
        self.dir_state.root = Some(dir_root.to_path_buf());
        self.definitions_dirty = false;
        Ok(())
    }

    fn resolve_server(
        &self,
        server: &LanguageServerAcquisition,
        dir_root: &Path,
        configuration: &LanguageServersConfig,
    ) -> Result<ManagedLanguageServer, String> {
        let config = configuration
            .servers
            .iter()
            .find_map(|(id, config)| (id.as_str() == server.id).then_some(config));
        let explicit = config.and_then(|config| config.executable.as_deref());
        let environment = config
            .map(|config| config.environment.clone())
            .unwrap_or_default();
        let result = server.resolve(
            dir_root,
            explicit,
            &InstallContext::current(),
            &environment,
            || {
                let home = self.home.as_deref().ok_or_else(|| {
                    ManagedLanguageServerError::Installation("Ash home is unavailable".into())
                })?;
                let mut downloading = false;
                let result = (|| {
                    use ash_http_client::HttpClientConfig;
                    use ash_http_client::OutboundNetworkSnapshot;
                    use ash_http_client::RedirectPolicy;
                    use ash_http_client::ReqwestHttpClient;
                    use ash_http_client::ResponseBodyLimit;
                    let config = HttpClientConfig::default()
                        .with_response_body_limit(
                            ResponseBodyLimit::new(
                                std::num::NonZeroUsize::new(128 * 1024 * 1024).unwrap(),
                            )
                            .unwrap(),
                        )
                        .with_redirect_policy(RedirectPolicy::Follow {
                            max_hops: std::num::NonZeroU8::new(5).unwrap(),
                        });
                    let network =
                        OutboundNetworkSnapshot::with_policy(config, self.network_policy.clone())
                            .map_err(|error| {
                            ManagedLanguageServerError::Installation(error.to_string())
                        })?;
                    let http = ReqwestHttpClient::with_network(network).map_err(|error| {
                        ManagedLanguageServerError::Installation(error.to_string())
                    })?;
                    server.install(home, &http, || {
                        downloading = true;
                        self.updates.publish_language_server_progress(
                            self.connection_id,
                            LanguageServerProgressNotification {
                                dir_id: self.dir_state.dir_id.clone(),
                                server: server.id.clone(),
                                token: "ash.language-server.download".into(),
                                title: Some(server.id.clone()),
                                message: None,
                                percentage: None,
                                done: false,
                            },
                        );
                    })
                })();
                if downloading {
                    self.updates.publish_language_server_progress(
                        self.connection_id,
                        LanguageServerProgressNotification {
                            dir_id: self.dir_state.dir_id.clone(),
                            server: server.id.clone(),
                            token: "ash.language-server.download".into(),
                            title: None,
                            message: None,
                            percentage: None,
                            done: true,
                        },
                    );
                }
                result
            },
        );
        if let Err(error) = &result {
            self.updates.publish_language_server_state(
                self.connection_id,
                LanguageServerStateNotification {
                    dir_id: self.dir_state.dir_id.clone(),
                    server: server.id.clone(),
                    state: LanguageServerStateDto::Failed {
                        message: error.to_string(),
                    },
                },
            );
        }
        result.map_err(|error| error.to_string())
    }

    fn wait_until_ready(&mut self, language_id: &str) -> Result<(), String> {
        let server = self
            .dir_state
            .language_servers
            .get(language_id)
            .cloned()
            .ok_or_else(|| format!("no language server is available for '{language_id}'"))?;
        let deadline = Instant::now() + SERVER_START_TIMEOUT;
        loop {
            let version = self
                .sources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .versions
                .get(&server)
                .copied()
                .unwrap_or(0);
            if version != self.source_versions.get(&server).copied().unwrap_or(0) {
                return Err("language server source was retired".into());
            }
            if self
                .connection_cancellation
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
                || self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.cancellation.token().is_cancelled())
            {
                return Err("language session was cancelled".into());
            }
            match self.dir_state.server_states.get(&server) {
                Some(LanguageServerState::Ready) => return Ok(()),
                Some(LanguageServerState::Failed(message)) => return Err(message.clone()),
                Some(LanguageServerState::CrashLoop { message, .. }) => return Err(message.clone()),
                Some(LanguageServerState::UserStopped) => {
                    return Err("language server was stopped by the user".into());
                }
                _ => {}
            }
            if let Some(event) = self.recv_until(deadline)? {
                self.accept_state(&event);
            }
        }
    }

    fn recv_until(&self, deadline: Instant) -> Result<Option<LspManagerEvent>, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("language service request timed out".into());
        }
        match self
            .receiver
            .as_ref()
            .ok_or_else(|| String::from("language service event channel is unavailable"))?
            .recv_timeout(remaining.min(Duration::from_millis(25)))
        {
            Ok(event) => Ok(Some(event)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("language service event channel is unavailable".into())
            }
        }
    }

    fn accept_state(&mut self, event: &LspManagerEvent) {
        if let LspManagerEvent::Notification(LspManagerNotification::ServerStateChanged {
            server,
            state,
        }) = event
        {
            self.dir_state
                .server_states
                .insert(server.clone(), state.clone());
        }
    }

    fn shutdown(&mut self) {
        let connections = self.connections.keys().copied().collect::<Vec<_>>();
        for connection in connections {
            self.close_connection(connection);
        }
        self.env_runtimes.clear();
        self.active_dir_root = None;
        self.shutdown_selected();
    }

    fn shutdown_selected(&mut self) {
        if let Ok(mut documents) = self.dir_state.documents.lock() {
            documents.clear();
        }
        if let Some(session) = self.session.take() {
            session.cancellation.cancel();
        }
        if let Some(manager) = self.manager.take() {
            let _ = manager.set_enablement(ash_lsp_manager::LspManagerEnablement::Disabled);
        }
        self.acquired
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.receiver = None;
        self.dir_state.root = None;
        self.dir_state.language_servers.clear();
        self.dir_state.server_states.clear();
    }
}

fn configured_provider_definitions(
    providers: &LspServerProviders,
    configuration: &LanguageServersConfig,
    dir_root: &Path,
) -> Result<Vec<ash_lsp_manager::LanguageServerDefinition>, String> {
    let mut definitions = Vec::new();
    for server_id in providers.ids() {
        let config = configuration
            .servers
            .iter()
            .find_map(|(id, config)| (id.as_str() == server_id).then_some(config));
        if config.is_none() && !providers.activation_enables(server_id) {
            continue;
        }
        if config.is_some_and(|config| config.mode == LanguageServerModeConfig::Disabled) {
            continue;
        }
        let launch = config
            .and_then(|config| config.executable.as_deref())
            .map_or(
                LspServerLaunch::Packaged,
                LspServerLaunch::ExplicitExecutable,
            );
        match providers.definition(server_id, dir_root, launch) {
            Ok(Some(definition)) => definitions.push(definition),
            Ok(None) => {}
            Err(error) => log::warn!("language server {server_id} is unavailable: {error}"),
        }
    }
    Ok(definitions)
}

impl Drop for AppServerLanguageRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn preference(configuration: &LanguageServersConfig, server_id: &str) -> LanguageServerPreference {
    let Some(configured) = configuration
        .servers
        .iter()
        .find_map(|(id, config)| (id.as_str() == server_id).then_some(config))
    else {
        return LanguageServerPreference::disabled();
    };
    let preference = match configured.mode {
        LanguageServerModeConfig::Disabled => LanguageServerPreference::disabled(),
        LanguageServerModeConfig::Enabled => LanguageServerPreference::enabled(),
    };
    configured
        .executable
        .as_ref()
        .map_or(preference.clone(), |path| {
            preference.with_explicit_executable(path)
        })
}

#[cfg(test)]
#[path = "language_runtime_tests.rs"]
mod tests;

fn configure_definition(
    mut definition: ash_lsp_manager::LanguageServerDefinition,
    configuration: &LanguageServersConfig,
    workspace_settings: &BTreeMap<String, serde_json::Value>,
) -> Result<ash_lsp_manager::LanguageServerDefinition, String> {
    let mut settings = serde_json::to_value(definition.settings()).expect("JSON settings");
    let mut initialization_options = None;
    if let Some(config) = configuration
        .servers
        .iter()
        .find_map(|(id, config)| (id.as_str() == definition.name().as_str()).then_some(config))
    {
        if !config.language_ids.is_empty() {
            definition = definition
                .with_language_ids(&config.language_ids)
                .map_err(|error| error.to_string())?;
        }
        definition = definition.with_launch_options(&config.args, &config.environment);
        merge_settings(
            &mut settings,
            &serde_json::to_value(&config.settings).expect("JSON settings"),
        );
        if let Some(options) = &config.initialization_options {
            initialization_options = Some(options.clone());
        }
    }
    if let Some(value) = workspace_settings.get(definition.name().as_str()) {
        merge_settings(&mut settings[definition.name().as_str()], value);
    }
    // rust-analyzer consumes its section during initialize, before requesting
    // workspace/configuration. Supplying only the latter starts Cargo with defaults.
    if definition.name().as_str() == "rust-analyzer"
        && let Some(rust_settings) = settings.get("rust-analyzer")
    {
        merge_settings(
            initialization_options.get_or_insert_with(|| serde_json::json!({})),
            rust_settings,
        );
    }
    if let Some(options) = initialization_options {
        definition = definition.with_initialization_options(options);
    }
    definition =
        definition.with_settings(serde_json::from_value(settings).expect("settings object"));
    Ok(definition)
}

fn merge_settings(base: &mut serde_json::Value, overlay: &serde_json::Value) {
    if let (Some(base), Some(overlay)) = (base.as_object_mut(), overlay.as_object()) {
        for (key, value) in overlay {
            merge_settings(base.entry(key).or_insert(serde_json::Value::Null), value);
        }
    } else {
        *base = overlay.clone();
    }
}

#[cfg(all(test, unix))]
#[path = "language_runtime_regression_tests.rs"]
mod regression_tests;
