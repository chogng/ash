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
    routes: BTreeMap<String, Vec<String>>,
    sender: mpsc::Sender<LspManagerEvent>,
    diagnostics: Arc<LanguageDiagnosticPublisher>,
}

impl LspManagerEventSink for AppServerLanguageEventSink {
    fn on_event(&self, event: LspManagerEvent) {
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
        if let LspManagerEvent::Notification(LspManagerNotification::CapabilitiesChanged {
            server,
            capabilities,
        }) = &event
        {
            self.diagnostics.updates.publish_language_server_capabilities(
                self.diagnostics.connection_id,
                ash_app_server_protocol::protocol::language::LanguageServerCapabilitiesNotification {
                    dir_id: self.diagnostics.dir_id.clone(), server: server.clone(),
                    language_ids: self.routes.get(server).cloned().unwrap_or_default(),
                    completion_trigger_characters: capabilities.completion_trigger_characters.clone(),
                    signature_help_trigger_characters: capabilities.signature_help_trigger_characters.clone(),
                    signature_help_retrigger_characters: capabilities.signature_help_retrigger_characters.clone(),
                },
            );
        }
        let _ = self.sender.send(event);
    }
}

fn language_server_state_to_dto(state: &LanguageServerState) -> LanguageServerStateDto {
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
        LanguageServerState::Stopped => LanguageServerStateDto::Stopped,
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
    config_generation: Option<u64>,
    language_servers: BTreeMap<String, String>,
    server_states: BTreeMap<String, LanguageServerState>,
    dir_id: Option<String>,
}

impl Default for AppServerLanguageDirState {
    fn default() -> Self {
        Self {
            documents: Arc::new(Mutex::new(BTreeMap::new())),
            root: None,
            config_generation: None,
            language_servers: BTreeMap::new(),
            server_states: BTreeMap::new(),
            dir_id: None,
        }
    }
}

/// A connection borrows its own LSP session while the shared owner serializes catalog changes.
/// Editor revisions are local to a client, so they must never share a document-version table.
pub(super) struct LanguageRuntimeGuard<'a> {
    runtime: std::sync::MutexGuard<'a, AppServerLanguageRuntime>,
    connection_id: u64,
}

impl<'a> LanguageRuntimeGuard<'a> {
    pub(super) fn new(
        mut runtime: std::sync::MutexGuard<'a, AppServerLanguageRuntime>,
        connection_id: u64,
    ) -> Self {
        if !runtime.connections.contains_key(&connection_id) {
            let mut child = runtime.child_runtime();
            child.connection_id = Some(connection_id);
            runtime.connections.insert(connection_id, Box::new(child));
        }
        Self {
            runtime,
            connection_id,
        }
    }
}
impl std::ops::Deref for LanguageRuntimeGuard<'_> {
    type Target = AppServerLanguageRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime.connections[&self.connection_id]
    }
}
impl std::ops::DerefMut for LanguageRuntimeGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.runtime
            .connections
            .get_mut(&self.connection_id)
            .expect("connection session exists")
    }
}

pub(super) struct AppServerLanguageRuntime {
    pub(super) manager: Option<LspManager>,
    receiver: Option<mpsc::Receiver<LspManagerEvent>>,
    updates: Arc<UpdateBroker>,
    dir_state: AppServerLanguageDirState,
    providers: LspServerProviders,
    env_runtimes: BTreeMap<PathBuf, Box<AppServerLanguageRuntime>>,
    active_dir_root: Option<PathBuf>,
    home: Option<PathBuf>,
    network_policy: ash_http_client::OutboundNetworkPolicy,
    extension_generation: Option<(u64, u64)>,
    connections: BTreeMap<u64, Box<AppServerLanguageRuntime>>,
    connection_id: Option<u64>,
    // Last applied immutable Config snapshot, used only to invalidate runtime resources.
    applied_configuration: Option<LanguageServersConfig>,
    acquisitions: BTreeMap<String, LanguageServerAcquisition>,
    acquired: BTreeMap<String, ManagedLanguageServer>,
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
            applied_configuration: None,
            acquisitions: BTreeMap::new(),
            acquired: BTreeMap::new(),
        }
    }

    fn child_runtime(&self) -> Self {
        let mut runtime = Self::new(Arc::clone(&self.updates));
        runtime.providers = self.providers.clone();
        runtime.acquisitions = self.acquisitions.clone();
        runtime.extension_generation = self.extension_generation;
        runtime.home = self.home.clone();
        runtime.network_policy = self.network_policy.clone();
        runtime.connection_id = self.connection_id;
        runtime
    }

    pub(super) fn reconcile_configuration(&mut self, configuration: &LanguageServersConfig) {
        if self.applied_configuration.as_ref() != Some(configuration) {
            self.shutdown();
            self.applied_configuration = Some(configuration.clone());
        }
    }

    pub(super) fn close_connection(&mut self, connection_id: u64) {
        self.connections.remove(&connection_id);
    }

    pub(super) fn set_server_providers(&mut self, providers: LspServerProviders) {
        self.shutdown();
        self.providers = providers;
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
        self.shutdown();
        self.acquisitions = acquisitions;
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
                active.is_some_and(|runtime| runtime.acquired.contains_key(&server.id))
                    || server
                        .workspace_files
                        .iter()
                        .any(|file| root.join(file).is_file())
            })
    }

    pub(super) fn server_running(&self, id: &str) -> bool {
        self.acquired.contains_key(id)
            || self
                .connections
                .values()
                .any(|runtime| runtime.server_running(id))
            || self
                .env_runtimes
                .values()
                .any(|runtime| runtime.server_running(id))
    }

    pub(super) fn invalidate_extensions(&mut self) {
        self.shutdown();
        self.extension_generation = None;
    }

    pub(super) fn reset_dirs(&mut self) {
        self.shutdown();
    }

    pub(super) fn retain_dir_roots(&mut self, roots: &std::collections::BTreeSet<PathBuf>) {
        for runtime in self.connections.values_mut() {
            runtime.retain_dir_roots(roots);
        }
        self.env_runtimes.retain(|root, _| roots.contains(root));
        if self
            .dir_state
            .root
            .as_ref()
            .is_some_and(|root| !roots.contains(root))
        {
            self.shutdown_selected();
        }
        if self
            .active_dir_root
            .as_ref()
            .is_some_and(|root| !roots.contains(root))
        {
            self.active_dir_root = None;
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
        if self.dir_state.root.is_some() && self.dir_state.root.as_deref() != Some(dir_root) {
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
        self.dir_state.dir_id = dir_id.map(str::to_owned);
        if self.dir_state.root.as_deref() != Some(dir_root)
            || self.dir_state.config_generation != Some(config_generation)
            || self.acquisitions(configuration).any(|server| {
                server.languages.iter().any(|id| id == language_id)
                    && !self.acquired.contains_key(&server.id)
            })
        {
            self.restart(dir_root, config_generation, configuration, language_id)?;
        }
        self.wait_until_ready(language_id)?;
        self.manager
            .as_ref()
            .ok_or_else(|| "language service is unavailable".into())
    }

    pub(super) fn manager(&self) -> Option<&LspManager> {
        match &self.active_dir_root {
            Some(root) => self
                .env_runtimes
                .get(root)
                .and_then(|runtime| runtime.manager()),
            None => self.manager.as_ref(),
        }
    }

    pub(super) fn wait_for_request(
        &mut self,
        request_id: LanguageRequestId,
        cancellation: &CancellationToken,
    ) -> Result<LspManagerRequestResult, String> {
        if let Some(root) = self.active_dir_root.clone() {
            return self
                .env_runtimes
                .get_mut(&root)
                .ok_or_else(|| String::from("language directory runtime is unavailable"))?
                .wait_for_request(request_id, cancellation);
        }
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if cancellation.is_cancelled() {
                if let Some(manager) = self.manager() {
                    let _ = manager.cancel_request(request_id);
                }
                return Err("language request cancelled".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("language service request timed out".into());
            }
            let event = self
                .receiver
                .as_ref()
                .ok_or_else(|| String::from("language service event channel is unavailable"))?
                .recv_timeout(remaining.min(Duration::from_millis(25)))
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => String::new(),
                    mpsc::RecvTimeoutError::Disconnected => {
                        String::from("language service event channel is unavailable")
                    }
                });
            let event = match event {
                Ok(event) => event,
                Err(message) if message.is_empty() => continue,
                Err(message) => return Err(message),
            };
            let matches = matches!(
                &event,
                LspManagerEvent::RequestResult(result) if result.request_id() == request_id
            );
            self.accept_state(&event);
            if matches {
                let LspManagerEvent::RequestResult(result) = event else {
                    unreachable!("request result match must contain a request result")
                };
                return Ok(result);
            }
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
                match configure_definition(definition, configuration) {
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
        let documents = self
            .dir_state
            .documents
            .lock()
            .map_err(|_| String::from("language document snapshots are unavailable"))?
            .clone();
        let previous: std::collections::BTreeSet<_> = self.acquired.keys().cloned().collect();
        // Retire the previous commands before resolving new intent. A failed explicit override
        // must not leave the old server running as an accidental fallback.
        self.shutdown_selected();
        let mut acquired = BTreeMap::new();
        for server in self.acquisitions(configuration).filter(|server| {
            server.languages.iter().any(|id| id == language_id) || previous.contains(&server.id)
        }) {
            // Each acquisition reports its own failure. Keep unrelated languages usable,
            // including when a previously running server's override has become stale.
            if let Ok(resolved) = self.resolve_server(server, dir_root, configuration) {
                acquired.insert(server.id.clone(), resolved);
            }
        }
        self.acquired = acquired;
        let mut definitions = self.definitions(dir_root, configuration)?;
        for server in self.acquired.values() {
            definitions.push(configure_definition(
                server.definition().clone(),
                configuration,
            )?);
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
        let routes = definitions
            .iter()
            .map(|definition| {
                (
                    definition.name().as_str().to_owned(),
                    definition.language_ids().map(str::to_owned).collect(),
                )
            })
            .collect();
        let (sender, receiver) = mpsc::channel();
        let manager = LspManager::start_with_events_and_metrics(
            LspManagerConfiguration::enabled(dir_root, definitions)
                .with_generation(config_generation),
            Arc::new(AppServerLanguageEventSink {
                routes,
                sender,
                diagnostics: Arc::new(LanguageDiagnosticPublisher {
                    documents: Arc::clone(&self.dir_state.documents),
                    updates: Arc::clone(&self.updates),
                    dir_id: self.dir_state.dir_id.clone(),
                    connection_id: self.connection_id,
                }),
            }),
            Arc::new(AppServerLanguageMetrics),
        )
        .map_err(|error| error.to_string())?;
        self.manager = Some(manager);
        self.receiver = Some(receiver);
        self.dir_state.root = Some(dir_root.to_path_buf());
        self.dir_state.config_generation = Some(config_generation);
        // Activating another extension server must preserve already-open LSP documents.
        for (path, snapshot) in documents {
            if self
                .dir_state
                .language_servers
                .contains_key(&snapshot.language_id)
            {
                let document = LspDocumentSnapshot::new(
                    path,
                    snapshot.language_id,
                    snapshot.revision,
                    snapshot.text,
                )
                .map_err(|error| error.to_string())?;
                self.synchronize_selected_document(&snapshot.relative_path, document)?;
            }
        }
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
                self.updates.publish_language_server_progress(
                    self.connection_id,
                    LanguageServerProgressNotification {
                        dir_id: self.dir_state.dir_id.clone(),
                        server: server.id.clone(),
                        token: "ash.language-server.install".into(),
                        title: Some(server.id.clone()),
                        message: None,
                        percentage: None,
                        done: false,
                    },
                );
                let install = || {
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
                    server.install(home, &http)
                };
                let result = install();
                self.updates.publish_language_server_progress(
                    self.connection_id,
                    LanguageServerProgressNotification {
                        dir_id: self.dir_state.dir_id.clone(),
                        server: server.id.clone(),
                        token: "ash.language-server.install".into(),
                        title: None,
                        message: None,
                        percentage: None,
                        done: true,
                    },
                );
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
        if matches!(
            self.dir_state.server_states.get(&server),
            Some(LanguageServerState::Ready)
        ) {
            return Ok(());
        }
        let deadline = Instant::now() + SERVER_START_TIMEOUT;
        loop {
            let event = self.recv_until(deadline)?;
            self.accept_state(&event);
            match self.dir_state.server_states.get(&server) {
                Some(LanguageServerState::Ready) => return Ok(()),
                Some(LanguageServerState::Failed(message)) => return Err(message.clone()),
                Some(LanguageServerState::CrashLoop { message, .. }) => return Err(message.clone()),
                _ => {}
            }
        }
    }

    fn recv_until(&self, deadline: Instant) -> Result<LspManagerEvent, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("language service request timed out".into());
        }
        self.receiver
            .as_ref()
            .ok_or_else(|| String::from("language service event channel is unavailable"))?
            .recv_timeout(remaining)
            .map_err(|_| "language service request timed out".into())
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
        self.connections.clear();
        self.env_runtimes.clear();
        self.active_dir_root = None;
        self.shutdown_selected();
    }

    fn shutdown_selected(&mut self) {
        if let Ok(mut documents) = self.dir_state.documents.lock() {
            documents.clear();
        }
        if let Some(manager) = self.manager.take() {
            let _ = manager.shutdown();
        }
        self.acquired.clear();
        self.receiver = None;
        self.dir_state.root = None;
        self.dir_state.config_generation = None;
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
) -> Result<ash_lsp_manager::LanguageServerDefinition, String> {
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
        definition = definition
            .with_launch_options(&config.args, &config.environment)
            .with_settings(config.settings.clone());
        if let Some(options) = &config.initialization_options {
            definition = definition.with_initialization_options(options.clone());
        }
    }
    Ok(definition)
}
