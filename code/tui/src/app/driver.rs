mod command;
#[cfg(test)]
mod tests;

use super::App;
use super::AppCommand;
use super::AppEvent;
use super::completion::Completion;
use super::completion::apply_request_completion;
use super::requests::RequestCompletion;
use super::requests::RequestKey;
use super::requests::RequestOrigin;
use super::requests::RequestTasks;
use super::requests::request_key;
use crate::client;
use crate::connectors;
use crate::host::Command as HostCommand;
use crate::sessions;
use crate::sessions::Conversation;
use crate::sessions::Event as SessionEvent;
use crate::skills;
use crate::skills::finish_refresh;
use crate::status::Event as StatusEvent;
use crate::theme::ThemeResource;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadCompletion;
use crate::thread::ThreadRequestScope;
use crate::thread::ThreadUpdateDisposition;
use crate::thread::TranscriptUpdateDisposition;
use crate::thread::composer::file_search::FileSearchManager;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::query::Query;
use crate::thread::read_thread_history;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;
use std::collections::VecDeque;
use std::path::PathBuf;

#[derive(Debug, Eq, PartialEq)]
pub(super) struct ScheduledCommand {
    pub(super) command: AppCommand,
    pub(super) origin: RequestOrigin,
}

impl ScheduledCommand {
    pub(super) fn new(command: AppCommand, app: &App) -> Self {
        Self {
            command,
            origin: RequestOrigin::current(app),
        }
    }
}

pub(super) enum CommandEffect {
    None,
    Quit,
    Suspend,
    OpenWorkspace(PathBuf),
}

#[derive(Default)]
struct ServerRefresh {
    config: bool,
    hooks: bool,
    connectors: bool,
    sessions: bool,
    thread: bool,
    skills: bool,
    packages: bool,
    language_servers: bool,
}

impl ServerRefresh {
    fn merge(&mut self, refresh: Self) {
        self.config |= refresh.config;
        self.hooks |= refresh.config || refresh.hooks;
        self.connectors |= refresh.connectors;
        self.sessions |= refresh.sessions;
        self.thread |= refresh.thread;
        self.skills |= refresh.skills;
        self.packages |= refresh.packages;
        self.language_servers |= refresh.language_servers;
    }
}

/// Owns the client-bound state and background work for one visible TUI session.
pub(super) struct AppDriver {
    app: App,
    client: AppServerRequestHandle,
    conversation: Option<Conversation>,
    requests: RequestTasks,
    queued_commands: VecDeque<ScheduledCommand>,
    refresh: ServerRefresh,
    queue_refresh_requested: bool,
    model_picker: crate::models::ModelPickerData,
    file_search: Option<FileSearchManager>,
    host_dir_root: PathBuf,
    theme_resource: ThemeResource,
    server_slash_commands: Vec<SlashCommandDefinition>,
    plugins_enabled: bool,
    memory: crate::memory::Controller,
    dictation_settings: std::sync::Arc<crate::config::LocalDictationSettings>,
    dictation_settings_changes: std::sync::mpsc::Receiver<ash_config::ConfigChange>,
}

pub(super) struct AppDriverResources {
    pub(super) file_search: Option<FileSearchManager>,
    pub(super) host_dir_root: PathBuf,
    pub(super) theme_resource: ThemeResource,
    pub(super) server_slash_commands: Vec<SlashCommandDefinition>,
    pub(super) plugins_enabled: bool,
    pub(super) dictation_settings: std::sync::Arc<crate::config::LocalDictationSettings>,
    pub(super) model_picker: crate::models::ModelPickerData,
}

impl AppDriver {
    pub(super) fn new(
        app: App,
        client: AppServerRequestHandle,
        conversation: Option<Conversation>,
        resources: AppDriverResources,
    ) -> Self {
        let dictation_settings_changes = resources.dictation_settings.subscribe_changes();
        let initial =
            ScheduledCommand::new(HostCommand::RefreshClipboardImageAvailability.into(), &app);
        let mut driver = Self {
            app,
            client,
            conversation,
            requests: RequestTasks::default(),
            queued_commands: VecDeque::from([initial]),
            refresh: ServerRefresh::default(),
            queue_refresh_requested: true,
            model_picker: resources.model_picker,
            file_search: resources.file_search,
            host_dir_root: resources.host_dir_root,
            theme_resource: resources.theme_resource,
            server_slash_commands: resources.server_slash_commands,
            plugins_enabled: resources.plugins_enabled,
            memory: crate::memory::Controller::default(),
            dictation_settings: resources.dictation_settings,
            dictation_settings_changes,
        };
        driver.reconcile_memory_diagnostics();
        driver
    }

    pub(super) fn app(&self) -> &App {
        &self.app
    }

    pub(super) fn app_mut(&mut self) -> &mut App {
        &mut self.app
    }

    pub(super) fn recovery_state(&self) -> Option<crate::TuiRecoveryState> {
        self.conversation.as_ref().map(|current| {
            crate::TuiRecoveryState::new(
                current.conversation.session_id().clone(),
                current.conversation.thread_id().clone(),
            )
        })
    }

    pub(super) fn recovery_drafts(&self) -> crate::TuiRecoveryDrafts {
        self.app.recovery_drafts()
    }

    pub(super) fn handle_client_event(&mut self, event: client::ClientEvent) {
        let stale_dictation = match &event {
            client::ClientEvent::DictationTranscript(transcript) => self
                .app
                .dictation_scope_changed(&transcript.resource_id)
                .then(|| transcript.resource_id.clone()),
            _ => None,
        };
        let ended_dictation = match &event {
            client::ClientEvent::DictationEnded(ended)
                if !self.app.dictation_stop_pending(&ended.resource_id) =>
            {
                Some(ended.resource_id.clone())
            }
            _ => None,
        };
        if matches!(event, client::ClientEvent::QueueChanged) {
            self.queue_refresh_requested = true;
        }
        let refresh = refresh_server_event(event, self.conversation.as_mut(), &mut self.app);
        self.refresh.merge(refresh);
        if let Some(resource_id) = ended_dictation {
            let _ = self.client.clone().stop_dictation(resource_id);
        }
        if let Some(resource_id) = stale_dictation {
            let _ = self.client.clone().stop_dictation(resource_id);
        }
    }

    pub(super) fn poll_request_completions(&mut self) -> bool {
        let local_settings_changed = self.dictation_settings_changes.try_iter().last().is_some();
        if local_settings_changed {
            match self.dictation_settings.read() {
                Ok(settings) => self.app.set_dictation_shortcut_settings(settings),
                Err(error) => self.app.update(ThreadEvent::FailureReported(error)),
            }
        }
        self.memory.observe_objects(self.app.memory_object_count());
        let completions = self.requests.poll();
        let mut changed =
            local_settings_changed || self.app.poll_input_history() || !completions.is_empty();
        for completion in completions {
            let thread_before = self
                .conversation
                .as_ref()
                .map(|current| current.conversation.thread_id().clone());
            match completion {
                Ok(RequestCompletion {
                    completion: Completion::Memory(completion),
                    ..
                }) => {
                    let previous = self.memory.status();
                    if let Err(error) = self.memory.complete(completion) {
                        self.app.update(ThreadEvent::FailureReported(error));
                    }
                    self.publish_memory_status(previous);
                }
                Ok(RequestCompletion { completion, origin }) => {
                    if let Completion::ConfigRefreshed(Ok((config, catalog))) = &completion {
                        self.model_picker.update_config(config.clone());
                        self.model_picker.update_catalog(catalog.clone());
                        if matches!(
                            self.app.command_panel(),
                            Some(super::command_panel::CommandPanel::Model(_))
                        ) && let Ok(choices) = self.model_picker.choices()
                        {
                            self.app.update_for_panel(
                                self.app.panels().generation(),
                                crate::models::Event::PickerUpdated(choices),
                            );
                        }
                    }
                    if let Completion::ModelUpdated {
                        result: Ok(update), ..
                    } = &completion
                    {
                        self.model_picker.update_config(update.config.clone());
                        if let Some(catalog) = &update.catalog {
                            self.model_picker.update_catalog(catalog.clone());
                        }
                    }
                    apply_request_completion(
                        completion,
                        origin,
                        &mut self.conversation,
                        &mut self.app,
                    );
                }
                Err(error) => self
                    .app
                    .update(ThreadEvent::FailureReported(error.to_string())),
            }
            if self
                .conversation
                .as_ref()
                .map(|current| current.conversation.thread_id())
                != thread_before.as_ref()
            {
                self.queue_refresh_requested = true;
            }
        }
        if let Some(command) = self.app.take_dictation_stop_requested() {
            self.queued_commands
                .push_back(ScheduledCommand::new(command, &self.app));
            changed = true;
        }
        if let Some(command) = self.app.take_dictation_submission() {
            self.queued_commands
                .push_back(ScheduledCommand::new(command, &self.app));
            changed = true;
        }
        changed |= self.reconcile_memory_diagnostics();
        changed
    }

    fn reconcile_memory_diagnostics(&mut self) -> bool {
        let origin = RequestOrigin::current(&self.app);
        let previous = self.memory.status();
        let request = match self
            .memory
            .reconcile(self.app.memory_diagnostics_enabled(), self.client.clone())
        {
            Ok(request) => request,
            Err(error) => {
                self.app.update(ThreadEvent::FailureReported(error));
                None
            }
        };
        self.publish_memory_status(previous);
        let Some(request) = request else {
            return previous != self.memory.status();
        };
        let name = request.name();
        self.requests.spawn(
            Some(RequestKey::Memory),
            name,
            move || Completion::Memory(request.execute()),
            &mut self.app,
            origin,
        );
        if self.requests.is_idle(Some(RequestKey::Memory)) {
            let previous = self.memory.status();
            self.memory.schedule_failed();
            self.publish_memory_status(previous);
        }
        true
    }

    fn publish_memory_status(&mut self, previous: crate::memory::Status) {
        let status = self.memory.status();
        if status != previous {
            self.app
                .update(StatusEvent::MemoryDiagnosticsChanged(status));
        }
    }

    pub(super) fn next_command(
        &mut self,
        command: Option<AppCommand>,
        had_active_turn: bool,
    ) -> Option<ScheduledCommand> {
        if let Some(path) = self.app.take_workspace_open() {
            return Some(ScheduledCommand::new(
                AppCommand::OpenWorkspace { path },
                &self.app,
            ));
        }
        let command = command.and_then(|command| {
            if matches!(
                command,
                AppCommand::Models(crate::models::Command::OpenEffortPicker)
            ) {
                match self.model_picker.effort_choices() {
                    Ok(choices) => self.app.open_command_panel(
                        super::command_panel::CommandPanel::composer_options(choices),
                    ),
                    Err(error) => self.app.report_composer_option_error(error),
                }
                return None;
            }
            if let AppCommand::Thread(ThreadCommand::ExecuteProductCommand(invocation)) = &command
                && invocation.command.name == "model"
                && invocation.arguments.is_empty()
            {
                match self.model_picker.choices() {
                    Ok(choices) => {
                        self.app.update(crate::models::Event::PickerOpened(choices));
                    }
                    Err(error) => self.app.update(ThreadEvent::FailureReported(error)),
                }
                return None;
            }
            match (&command, self.app.panels_mut().command_mut()) {
                (
                    AppCommand::Marketplace(_),
                    Some(super::command_panel::CommandPanel::Marketplace(panel)),
                ) => panel.begin_request(),
                (AppCommand::Lsp(_), Some(super::command_panel::CommandPanel::Lsp(panel))) => {
                    panel.begin_request()
                }
                (AppCommand::Marketplace(_), _) => {
                    self.app
                        .open_command_panel(super::command_panel::CommandPanel::loading(
                            "Marketplace",
                            "Loading…",
                        ))
                }
                (AppCommand::Lsp(_), _) => {
                    self.app
                        .open_command_panel(super::command_panel::CommandPanel::loading(
                            "Language servers",
                            "Loading…",
                        ))
                }
                _ => {}
            }
            if let Some(title) = command.panel_title() {
                self.app
                    .open_command_panel(super::command_panel::CommandPanel::loading(
                        title,
                        "Loading…",
                    ));
            }
            Some(ScheduledCommand::new(command, &self.app))
        });
        self.queue_refresh_requested |= had_active_turn && self.app.active_turn().is_none();

        let mut command = schedule_command(command, &self.requests, &mut self.queued_commands);
        if command.is_none()
            && self.requests.is_idle(Some(RequestKey::Thread))
            && self.queued_commands.is_empty()
            && self.queue_refresh_requested
            && self.conversation.is_some()
        {
            command = self
                .app
                .refresh_queued_messages()
                .map(|command| ScheduledCommand::new(command, &self.app));
            self.queue_refresh_requested = false;
        }
        command
    }

    pub(super) fn poll_file_search(&mut self) -> bool {
        let Some(file_search) = self.file_search.as_mut() else {
            return false;
        };
        sync_file_search_query(&self.app, file_search);
        let snapshots = file_search.poll();
        let changed = !snapshots.is_empty();
        for snapshot in snapshots {
            self.app
                .update(ThreadEvent::FileSearchSnapshotReceived(snapshot));
        }
        changed
    }

    pub(super) fn schedule_refreshes(&mut self) {
        let origin = RequestOrigin::current(&self.app);
        if self.requests.is_idle(Some(RequestKey::Memories)) {
            let command = match self.app.panels_mut().command_mut() {
                Some(super::command_panel::CommandPanel::Memories(panel)) => panel.take_refresh(),
                _ => None,
            };
            if let Some(command) = command {
                let mut client = self.client.clone();
                let thread_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.thread_id().clone());
                self.requests.spawn_presentation(
                    Some(RequestKey::Memories),
                    "ash-tui-refresh-memories",
                    move || crate::memories::execute(&mut client, thread_id.as_ref(), command),
                    &mut self.app,
                    origin,
                );
            }
        }
        if self.refresh.packages && self.requests.is_idle(Some(RequestKey::Marketplace)) {
            self.refresh.packages = false;
            if let Some(super::command_panel::CommandPanel::Marketplace(panel)) =
                self.app.command_panel()
                && let Some(command) = panel.refresh()
            {
                if let Some(super::command_panel::CommandPanel::Marketplace(panel)) =
                    self.app.panels_mut().command_mut()
                {
                    panel.begin_request();
                }
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    Some(RequestKey::Marketplace),
                    "ash-tui-marketplace-refresh",
                    move || crate::marketplace::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
        }
        if self.refresh.language_servers && self.requests.is_idle(Some(RequestKey::Config)) {
            self.refresh.language_servers = false;
            if let Some(super::command_panel::CommandPanel::Lsp(panel)) = self.app.command_panel()
                && let Some(command) = panel.refresh()
            {
                let mut client = self.client.clone();
                let session_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.session_id().clone());
                if let Some(super::command_panel::CommandPanel::Lsp(panel)) =
                    self.app.panels_mut().command_mut()
                {
                    panel.begin_request();
                }
                self.requests.spawn_presentation(
                    Some(RequestKey::Config),
                    "ash-tui-lsp-refresh",
                    move || crate::lsp::execute(&mut client, session_id.as_ref(), command),
                    &mut self.app,
                    origin,
                );
            }
        }
        if self.refresh.hooks {
            if !matches!(
                self.app.command_panel(),
                Some(super::command_panel::CommandPanel::Hooks(_))
            ) {
                self.refresh.hooks = false;
            } else if self.requests.is_idle(Some(RequestKey::Hooks)) {
                let mut client = self.client.clone();
                let session_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.session_id().clone());
                self.requests.spawn_presentation(
                    Some(RequestKey::Hooks),
                    "ash-tui-refresh-hooks",
                    move || {
                        crate::hooks::execute(
                            &mut client,
                            session_id.as_ref(),
                            crate::hooks::Command::Refresh,
                        )
                    },
                    &mut self.app,
                    origin,
                );
                self.refresh.hooks = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::Config)) && self.refresh.config {
            let mut client = self.client.clone();
            self.requests.spawn(
                Some(RequestKey::Config),
                "ash-tui-refresh-config",
                move || {
                    Completion::ConfigRefreshed((|| {
                        let config = client.read_config().map_err(|error| error.to_string())?;
                        let catalog = client.list_models().map_err(|error| error.to_string())?;
                        Ok((config, catalog))
                    })())
                },
                &mut self.app,
                origin,
            );
            if !self.requests.is_idle(Some(RequestKey::Config)) {
                self.refresh.config = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::Thread))
            && self.refresh.thread
            && self.conversation.is_some()
        {
            let mut client = self.client.clone();
            let scope = self
                .thread_request_scope()
                .expect("a subscribed conversation owns this refresh");
            let session_id = scope.session_id().clone();
            let thread_id = scope.thread_id().clone();
            let history = self.conversation.as_ref().unwrap().subscription.history();
            self.requests.spawn(
                Some(RequestKey::Thread),
                "ash-tui-refresh-thread",
                move || {
                    Completion::Thread(ThreadCompletion::Refreshed {
                        scope,
                        result: read_thread_history(&mut client, &session_id, &thread_id, history),
                    })
                },
                &mut self.app,
                origin,
            );
            if !self.requests.is_idle(Some(RequestKey::Thread)) {
                self.refresh.thread = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::Skills)) && self.refresh.skills {
            let client = self.client.clone();
            let server_slash_commands = self.server_slash_commands.clone();
            let session_id = self
                .conversation
                .as_ref()
                .map(|current| current.conversation.session_id().clone());
            let plugins_enabled = self.plugins_enabled;
            self.requests.spawn(
                Some(RequestKey::Skills),
                "ash-tui-refresh-skills",
                move || {
                    Completion::Skills(
                        skills::refresh(client, session_id, plugins_enabled)
                            .and_then(|refresh| finish_refresh(refresh, &server_slash_commands)),
                    )
                },
                &mut self.app,
                origin,
            );
            if !self.requests.is_idle(Some(RequestKey::Skills)) {
                self.refresh.skills = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::SessionDetails)) {
            if let Some((generation, session_id)) = self.app.take_session_details_request() {
                let mut client = self.client.clone();
                self.requests.spawn(
                    Some(RequestKey::SessionDetails),
                    "ash-tui-session-details",
                    move || {
                        Completion::Presentation(Ok(sessions::load_details(
                            &mut client,
                            generation,
                            session_id,
                        )
                        .into()))
                    },
                    &mut self.app,
                    origin,
                );
            }
        }
        if self.requests.is_idle(Some(RequestKey::Sessions)) && self.refresh.sessions {
            let mut client = self.client.clone();
            self.requests.spawn(
                Some(RequestKey::Sessions),
                "ash-tui-refresh-sessions",
                move || {
                    Completion::Presentation(
                        sessions::load_catalog(&mut client)
                            .map(SessionEvent::CatalogReceived)
                            .map(AppEvent::from)
                            .map_err(|error| error.to_string()),
                    )
                },
                &mut self.app,
                origin,
            );
            if !self.requests.is_idle(Some(RequestKey::Sessions)) {
                self.refresh.sessions = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::Connectors)) && self.refresh.connectors {
            let mut client = self.client.clone();
            self.requests.spawn(
                Some(RequestKey::Connectors),
                "ash-tui-refresh-connectors",
                move || {
                    Completion::Presentation(
                        connectors::load_selection(&mut client)
                            .map(connectors::Event::PickerUpdated)
                            .map(AppEvent::from)
                            .map_err(|error| error.to_string()),
                    )
                },
                &mut self.app,
                origin,
            );
            if !self.requests.is_idle(Some(RequestKey::Connectors)) {
                self.refresh.connectors = false;
            }
        }
        if self.requests.is_idle(Some(RequestKey::Git))
            && self.app.request_status_line_git_text_diff()
        {
            let mut client = self.client.clone();
            self.requests.spawn(
                Some(RequestKey::Git),
                "ash-tui-refresh-git-text-diff",
                move || {
                    Completion::Presentation(
                        client
                            .git_text_diff()
                            .map(|result| {
                                AppEvent::from(StatusEvent::GitTextDiffReceived {
                                    status: result.status,
                                    statistics: result.statistics,
                                })
                            })
                            .map_err(|error| error.to_string()),
                    )
                },
                &mut self.app,
                origin,
            );
        }
    }

    fn thread_request_scope(&self) -> Option<ThreadRequestScope> {
        let current = self.conversation.as_ref()?;
        Some(ThreadRequestScope::new(
            current.conversation.session_id(),
            current.conversation.thread_id(),
            current.conversation.thread_sequence(),
        ))
    }
}

pub(super) fn schedule_command(
    command: Option<ScheduledCommand>,
    requests: &RequestTasks,
    queued: &mut VecDeque<ScheduledCommand>,
) -> Option<ScheduledCommand> {
    if let Some(command) = command {
        let duplicate = match &command.command {
            AppCommand::Host(HostCommand::RefreshClipboardImageAvailability) => {
                queued.iter().any(|queued| {
                    matches!(
                        &queued.command,
                        AppCommand::Host(HostCommand::RefreshClipboardImageAvailability)
                    )
                })
            }
            AppCommand::Thread(ThreadCommand::LoadOlderHistory) => queued.iter().any(|queued| {
                matches!(
                    &queued.command,
                    AppCommand::Thread(ThreadCommand::LoadOlderHistory)
                )
            }),
            _ => false,
        };
        if !duplicate {
            queued.push_back(command);
        }
    }
    let runnable = queued
        .iter()
        .position(|command| requests.is_idle(request_key(&command.command)))?;
    queued.remove(runnable)
}

fn refresh_server_event(
    event: client::ClientEvent,
    current: Option<&mut Conversation>,
    app: &mut App,
) -> ServerRefresh {
    match event {
        client::ClientEvent::DictationModelProgress(progress) => {
            app.dictation_model_progress(&progress.resource_id, progress.stage);
            ServerRefresh::default()
        }
        client::ClientEvent::DictationTranscript(transcript) => {
            app.dictation_transcript(
                &transcript.resource_id,
                &transcript.text,
                transcript.is_final,
            );
            ServerRefresh::default()
        }
        client::ClientEvent::DictationEnded(ended) => {
            app.dictation_ended(&ended.resource_id, ended.error);
            ServerRefresh::default()
        }
        client::ClientEvent::Subscription(event) => {
            app.update(crate::config::Event::Subscription(event));
            ServerRefresh::default()
        }
        client::ClientEvent::QueueChanged => ServerRefresh::default(),
        client::ClientEvent::ConfigChanged => ServerRefresh {
            language_servers: true,
            config: true,
            ..ServerRefresh::default()
        },
        client::ClientEvent::AgentRequest(request) => {
            if current.is_some_and(|current| {
                request.session_id == *current.conversation.session_id()
                    && request.thread_id == *current.conversation.thread_id()
            }) {
                app.set_active_turn(request.turn_id.clone());
                let envelope = *request;
                let turn_id = envelope.turn_id;
                let request_id = envelope.interaction.request_id;
                match envelope.interaction.request {
                    ash_protocol::AgentRequest::Approval { request } => {
                        app.update(ThreadEvent::ApprovalRequested(Approval::open(
                            turn_id, request_id, request,
                        )));
                    }
                    ash_protocol::AgentRequest::UserInput { request } => {
                        match Query::open(turn_id, request_id, request) {
                            Ok(query) => app.update(ThreadEvent::QueryRequested(query)),
                            Err(error) => app.update(ThreadEvent::FailureReported(error)),
                        }
                    }
                    ash_protocol::AgentRequest::DynamicTool { .. } => {
                        app.update(ThreadEvent::FailureReported(
                            "dynamic Tool request is not supported by this TUI".into(),
                        ));
                    }
                }
            }
            ServerRefresh::default()
        }
        client::ClientEvent::MemoriesChanged(changed) => {
            app.update(crate::memories::Event::Changed(changed));
            ServerRefresh::default()
        }
        client::ClientEvent::SkillsChanged => ServerRefresh {
            skills: true,
            ..ServerRefresh::default()
        },
        client::ClientEvent::ConnectorsChanged => ServerRefresh {
            connectors: app.connector_picker_open(),
            ..ServerRefresh::default()
        },
        client::ClientEvent::PackageSourcesChanged => ServerRefresh {
            packages: true,
            language_servers: true,
            connectors: app.connector_picker_open(),
            skills: true,
            ..ServerRefresh::default()
        },
        client::ClientEvent::ConnectionClosed(_) => {
            unreachable!("connection failures leave through the recovery boundary")
        }
        client::ClientEvent::GitStatusChanged(status) => {
            app.update(StatusEvent::GitStatusReceived(status));
            ServerRefresh::default()
        }
        client::ClientEvent::SessionChanged(_) => ServerRefresh {
            sessions: true,
            ..ServerRefresh::default()
        },
        client::ClientEvent::ThreadUpdated(update) => {
            let Some(current) = current else {
                return ServerRefresh::default();
            };
            match current.subscription.classify_update(&update) {
                ThreadUpdateDisposition::Ignore => ServerRefresh::default(),
                ThreadUpdateDisposition::RefreshSnapshot => {
                    if let ash_protocol::ThreadUpdate::Committed {
                        event:
                            ash_protocol::ThreadEvent::TurnModeChanged {
                                turn_id,
                                from_mode,
                                mode,
                                ..
                            },
                    } = &update.update
                        && app.active_turn() == Some(turn_id)
                        && app.collaboration_mode() == *from_mode
                    {
                        app.set_collaboration_mode(*mode);
                    }
                    ServerRefresh {
                        thread: true,
                        ..ServerRefresh::default()
                    }
                }
            }
        }
        client::ClientEvent::ThreadTranscriptUpdated(update) => {
            let Some(current) = current else {
                return ServerRefresh::default();
            };
            match current.subscription.classify_transcript_update(&update) {
                TranscriptUpdateDisposition::Ignore => ServerRefresh::default(),
                TranscriptUpdateDisposition::Apply => {
                    app.update(ThreadEvent::TranscriptUpdateReceived(update));
                    ServerRefresh::default()
                }
                TranscriptUpdateDisposition::RefreshSnapshot => ServerRefresh {
                    thread: true,
                    ..ServerRefresh::default()
                },
            }
        }
    }
}

fn sync_file_search_query(app: &App, file_search: &mut FileSearchManager) {
    if let Some(query) = app.mention_query() {
        file_search.update_query(query);
    } else {
        file_search.stop();
    }
}
