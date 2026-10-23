//! Managed server launch, crash retirement, and bounded restart scheduling.

use super::*;

impl Supervisor {
    pub(super) async fn replace_servers(&mut self, definitions: Vec<LanguageServerDefinition>) {
        let removed = self
            .servers
            .iter()
            .filter_map(|(name, server)| {
                (!definitions.iter().any(|definition| {
                    definition.name() == name && definition.same_launch(&server.definition)
                }))
                .then(|| name.clone())
            })
            .collect::<Vec<_>>();
        for name in removed {
            self.retire_server(&name).await;
        }
        for definition in definitions {
            let name = definition.name().clone();
            if self.servers.contains_key(&name) {
                continue;
            }
            self.servers.insert(
                name.clone(),
                ManagedServer {
                    definition,
                    epoch: 0,
                    phase: ManagedServerPhase::Stopped,
                    restart: ServerRestartTracker::default(),
                },
            );
            if self.configuration.enablement == LspManagerEnablement::Enabled {
                self.start_server(&name);
            }
        }
        // Keep the manager's resource leases aligned with its live definitions.
        self.configuration.servers = self
            .servers
            .values()
            .map(|server| server.definition.clone())
            .collect();
    }

    pub(super) async fn retire_server(&mut self, name: &LanguageServerName) {
        if !self.servers.contains_key(name) {
            return;
        }
        if let Some((client, definition)) = self.detach_server(name) {
            self.close_retired_client(client, definition);
        }
        self.emit_server_state(name, LanguageServerState::Stopped);
    }

    fn detach_server(
        &mut self,
        name: &LanguageServerName,
    ) -> Option<(LanguageServerClient, LanguageServerDefinition)> {
        if !self.servers.contains_key(name) {
            return None;
        }
        if let Some(launch) = self.launches.remove(name) {
            launch.abort();
        }
        if let Some(retry) = self.retry_tasks.remove(name) {
            retry.abort();
        }
        let requests = self
            .in_flight_requests
            .iter()
            .filter_map(|(id, tracking)| (&tracking.server == name).then_some(*id))
            .collect::<Vec<_>>();
        for request in requests {
            if let Some(tracking) = self.in_flight_requests.remove(&request) {
                tracking.cancellation.cancel();
                self.emit_request_result(LspManagerRequestResult::RequestFailed {
                    request_id: request,
                    kind: tracking.kind,
                    path: tracking.path.clone(),
                    revision: tracking.revision,
                    message: "language server was retired".into(),
                });
                self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
            }
        }
        self.clear_diagnostics_for_server(name);
        self.mark_documents_unrouted(name);
        let retired = self.servers.remove(name);
        self.configuration
            .servers
            .retain(|definition| definition.name() != name);
        self.observed_request_kinds
            .retain(|(server, _, _)| server != name);
        match (self.router.remove_server(name), retired) {
            (Ok(client), Some(retired)) => Some((client, retired.definition)),
            _ => None,
        }
    }

    pub(super) async fn control_servers(
        &mut self,
        action: LanguageServerControl,
        names: Vec<LanguageServerName>,
    ) {
        let mut stopped = Vec::new();
        let mut shutdowns = tokio::task::JoinSet::new();
        for name in names {
            let Some(definition) = self
                .servers
                .get(&name)
                .map(|server| server.definition.clone())
            else {
                continue;
            };
            if action == LanguageServerControl::Resume
                && self.servers[&name].phase != ManagedServerPhase::Idle
            {
                continue;
            }
            if action == LanguageServerControl::Suspend
                && (self.servers[&name].phase != ManagedServerPhase::Ready
                    || self
                        .in_flight_requests
                        .values()
                        .any(|request| request.server == name)
                    || self.documents.values().any(|entry| {
                        definition
                            .language_ids()
                            .any(|language| language == entry.document.language_id())
                    }))
            {
                continue;
            }
            if let Some((client, retired_definition)) = self.detach_server(&name) {
                shutdowns.spawn(async move {
                    // Keep every source lease until its process is reaped. Batch shutdowns run
                    // together so one unresponsive server cannot multiply the timeout.
                    let _definition = retired_definition;
                    let _ = client.shutdown().await;
                });
            }
            self.configuration.servers.push(definition.clone());
            self.servers.insert(
                name.clone(),
                ManagedServer {
                    definition,
                    epoch: 0,
                    phase: if action == LanguageServerControl::Suspend {
                        ManagedServerPhase::Idle
                    } else {
                        ManagedServerPhase::Stopped
                    },
                    restart: ServerRestartTracker::default(),
                },
            );
            match action {
                LanguageServerControl::Stop => {
                    self.emit_server_state(&name, LanguageServerState::UserStopped)
                }
                LanguageServerControl::Restart | LanguageServerControl::Resume => {
                    self.emit_server_state(&name, LanguageServerState::Stopped)
                }
                LanguageServerControl::Suspend => {}
            }
            stopped.push(name);
        }
        while shutdowns.join_next().await.is_some() {}
        for name in stopped {
            match action {
                LanguageServerControl::Restart | LanguageServerControl::Resume => {
                    self.start_server(&name)
                }
                LanguageServerControl::Suspend => {
                    self.emit_server_state(&name, LanguageServerState::Idle)
                }
                LanguageServerControl::Stop => {}
            }
        }
    }

    fn close_retired_client(
        &mut self,
        client: LanguageServerClient,
        definition: LanguageServerDefinition,
    ) {
        self.retirements.retain(|task| !task.is_finished());
        self.retirements.push(tokio::spawn(async move {
            // Even a late initialize result owns a process. Retain its exact source until reap
            // without making the supervisor wait behind that obsolete server's shutdown.
            let _definition = definition;
            let _ = client.shutdown().await;
        }));
    }

    pub(super) async fn enable(&mut self) {
        self.generation = self.generation.saturating_add(1).max(1);
        for (_, retry) in self.retry_tasks.drain() {
            retry.abort();
        }
        for server in self.servers.values_mut() {
            server.phase = ManagedServerPhase::Stopped;
            server.restart.reset();
        }
        let names = self.servers.keys().cloned().collect::<Vec<_>>();
        for name in names {
            self.start_server(&name);
        }
    }

    fn start_server(&mut self, name: &LanguageServerName) {
        if let Some(retry) = self.retry_tasks.remove(name) {
            retry.abort();
        }
        let Some(server) = self.servers.get_mut(name) else {
            return;
        };
        self.next_server_epoch = self.next_server_epoch.saturating_add(1).max(1);
        server.epoch = self.next_server_epoch;
        server.phase = ManagedServerPhase::Starting;
        let server_epoch = server.epoch;
        let settings = server.definition.settings().clone();
        let launch_definition = server.definition.clone();
        let (route, command, initialization_options) =
            server.definition.clone().into_launch_parts();
        self.emit_server_state(name, LanguageServerState::Starting);
        let bridge = Arc::new(ProtocolEventBridge {
            server: name.clone(),
            generation: self.generation,
            server_epoch,
            commands: self.commands.clone(),
            settings,
        });
        let mut options = LanguageServerOptions::new("ash-lsp-manager", env!("CARGO_PKG_VERSION"))
            .with_host(bridge);
        if let Ok(root_uri) = file_uri(&self.configuration.dir_root) {
            options = options
                .with_root_uri(root_uri.clone())
                .with_workspace_folders(vec![ash_lsp::lsp_types::WorkspaceFolder {
                    uri: root_uri,
                    name: self
                        .configuration
                        .dir_root
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                }]);
        }
        if let Some(initialization_options) = initialization_options {
            options = options.with_initialization_options(initialization_options);
        }
        let commands = self.commands.clone();
        let generation = self.generation;
        let server_name = name.clone();
        let task = tokio::spawn(async move {
            let result = LanguageServerClient::start_stdio(command, options)
                .await
                .map_err(|error| error.to_string());
            let _ = commands.send(SupervisorCommand::ServerStarted {
                definition: launch_definition,
                server: server_name,
                generation,
                server_epoch,
                route,
                result,
            });
        });
        if let Some(previous) = self.launches.insert(name.clone(), task) {
            previous.abort();
        }
    }

    pub(super) fn retry_server(&mut self, name: &LanguageServerName, server_epoch: u64) {
        let can_retry = self.servers.get(name).is_some_and(|server| {
            server.epoch == server_epoch && server.phase == ManagedServerPhase::BackingOff
        });
        if can_retry {
            self.retry_tasks.remove(name);
            self.start_server(name);
        }
    }

    pub(super) async fn handle_server_started(
        &mut self,
        name: LanguageServerName,
        generation: u64,
        server_epoch: u64,
        route: LanguageServerRoute,
        definition: LanguageServerDefinition,
        result: Result<LanguageServerClient, String>,
    ) {
        let current = generation == self.generation
            && self.servers.get(&name).is_some_and(|server| {
                server.epoch == server_epoch && server.phase == ManagedServerPhase::Starting
            });
        if !current {
            if let Ok(client) = result {
                self.close_retired_client(client, definition);
            }
            return;
        }
        self.launches.remove(&name);
        let client = match result {
            Ok(client) => client,
            Err(message) => {
                self.schedule_failure(&name, server_epoch, message);
                return;
            }
        };
        let client_for_shutdown = client.clone();
        if let Err(error) = self.router.register(route, client) {
            self.close_retired_client(client_for_shutdown, definition);
            if let Some(server) = self.servers.get_mut(&name) {
                server.phase = ManagedServerPhase::Terminal;
            }
            self.emit_server_state(&name, LanguageServerState::Failed(error.to_string()));
            return;
        }
        if let Some(server) = self.servers.get_mut(&name) {
            server.phase = ManagedServerPhase::Ready;
            server.restart.mark_ready(Instant::now());
        }
        self.emit_server_state(&name, LanguageServerState::Ready);
        self.emit_server_capabilities(&name, server_epoch);
        self.route_documents_for_server(&name).await;
    }

    pub(super) async fn handle_server_disconnect(
        &mut self,
        name: &LanguageServerName,
        server_epoch: u64,
        message: String,
    ) {
        let current = self.servers.get(name).is_some_and(|server| {
            server.epoch == server_epoch && server.phase == ManagedServerPhase::Ready
        });
        if !current {
            return;
        }
        if let Some(server) = self.servers.get_mut(name) {
            server.phase = ManagedServerPhase::Starting;
        }
        self.clear_diagnostics_for_server(name);
        self.mark_documents_unrouted(name);
        let message = match self.router.remove_disconnected_server(name).await {
            Ok(_) => message,
            Err(error) => format!("{message}; could not retire disconnected route: {error}"),
        };
        self.schedule_failure(name, server_epoch, message);
    }

    pub(super) fn schedule_failure(
        &mut self,
        name: &LanguageServerName,
        server_epoch: u64,
        message: String,
    ) {
        let current = self.servers.get(name).is_some_and(|server| {
            server.epoch == server_epoch && server.phase == ManagedServerPhase::Starting
        });
        if !current {
            return;
        }
        let Some(server) = self.servers.get_mut(name) else {
            return;
        };
        let failure_message = message.clone();
        let decision =
            server
                .restart
                .failure(Instant::now(), message, self.configuration.restart_policy);
        match decision {
            RestartDecision::Failed(message) => {
                server.phase = ManagedServerPhase::Terminal;
                self.emit_server_state(name, LanguageServerState::Failed(message));
            }
            RestartDecision::CrashLoop {
                restart_attempts,
                message,
            } => {
                server.phase = ManagedServerPhase::Terminal;
                self.emit_server_state(
                    name,
                    LanguageServerState::CrashLoop {
                        restart_attempts,
                        message,
                    },
                );
            }
            RestartDecision::Backoff {
                attempt,
                retry_after,
            } => {
                server.phase = ManagedServerPhase::BackingOff;
                self.emit_notification(LspManagerNotification::ServerMessage {
                    server: name.to_string(),
                    severity: LanguageServerMessageSeverity::Error,
                    source: LanguageServerMessageSource::Service,
                    show: false,
                    message: failure_message,
                });
                self.emit_server_state(
                    name,
                    LanguageServerState::BackingOff {
                        attempt,
                        retry_after,
                    },
                );
                let commands = self.commands.clone();
                let server = name.clone();
                let generation = self.generation;
                let retry = tokio::spawn(async move {
                    tokio::time::sleep(retry_after).await;
                    let _ = commands.send(SupervisorCommand::RetryServer {
                        server,
                        generation,
                        server_epoch,
                    });
                });
                if let Some(previous) = self.retry_tasks.insert(name.clone(), retry) {
                    previous.abort();
                }
            }
        }
    }

    async fn route_documents_for_server(&mut self, name: &LanguageServerName) {
        let Some(server) = self.servers.get(name) else {
            return;
        };
        let languages = server
            .definition
            .language_ids()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let paths = self
            .documents
            .iter()
            .filter(|(_, document)| languages.contains(document.document.language_id()))
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in paths {
            self.route_current_document(&path).await;
        }
    }

    fn mark_documents_unrouted(&mut self, name: &LanguageServerName) {
        let Some(server) = self.servers.get(name) else {
            return;
        };
        let languages = server
            .definition
            .language_ids()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        for document in self.documents.values_mut() {
            if languages.contains(document.document.language_id()) {
                document.routed = false;
            }
        }
    }

    fn clear_diagnostics_for_server(&self, name: &LanguageServerName) {
        let Some(server) = self.servers.get(name) else {
            return;
        };
        let languages = server.definition.language_ids().collect::<BTreeSet<_>>();
        for (path, document) in &self.documents {
            if languages.contains(document.document.language_id()) {
                self.emit_notification(LspManagerNotification::Diagnostics(
                    LanguageDiagnostics::new(
                        path.clone(),
                        document.document.revision(),
                        Vec::new(),
                    ),
                ));
            }
        }
    }

    pub(super) async fn disable(&mut self) {
        self.cancel_all_language_requests();
        self.generation = self.generation.saturating_add(1).max(1);
        for (_, launch) in self.launches.drain() {
            launch.abort();
        }
        for (_, retry) in self.retry_tasks.drain() {
            retry.abort();
        }
        for document in self.documents.values_mut() {
            document.routed = false;
        }
        let stopped = self
            .servers
            .iter_mut()
            .filter_map(|(name, server)| {
                let was_active = server.phase != ManagedServerPhase::Stopped;
                server.phase = ManagedServerPhase::Stopped;
                server.epoch = server.epoch.saturating_add(1).max(1);
                server.restart.reset();
                was_active.then(|| name.clone())
            })
            .collect::<Vec<_>>();
        let router = std::mem::take(&mut self.router);
        for failure in router.shutdown().await {
            self.emit_notification(LspManagerNotification::ServerMessage {
                server: failure.server.to_string(),
                severity: LanguageServerMessageSeverity::Error,
                source: super::LanguageServerMessageSource::Service,
                show: false,
                message: failure.message,
            });
        }
        for retirement in self.retirements.drain(..) {
            let _ = retirement.await;
        }
        for server in stopped {
            self.emit_server_state(&server, LanguageServerState::Stopped);
        }
    }
}
