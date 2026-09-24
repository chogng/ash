use super::chat_panel::ChatPanel;
use super::command::AppCommand;
use super::command_panel::CommandPanel;
use super::command_panel::CommandPanelOutcome;
use super::escape::ScreenEscapeOutcome;
use super::escape::ScreenEscapeSequence;
use super::event::AppEvent;
use super::fullscreen::Fullscreen;
use super::help::help_choices;
use crate::TuiStartupContext;
use crate::app::top_tip::TopTip;
use crate::app::welcome::WelcomeModel;
use crate::config::Command as ConfigCommand;
use crate::config::ConfigSelectionAction;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::connectors::Command as ConnectorCommand;
use crate::connectors::ConnectorChoices;
use crate::connectors::ConnectorSelectionAction;
use crate::connectors::Event as ConnectorEvent;
use crate::dirs::Command as DirCommand;
use crate::dirs::DirAddTarget;
use crate::dirs::DirChoices;
use crate::dirs::DirSelectionAction;
use crate::dirs::Event as DirEvent;
use crate::git::Command as GitCommand;
use crate::git::Event as GitEvent;
use crate::host::Command as HostCommand;
use crate::host::Event as HostEvent;
use crate::host::clipboard::ClipboardImage;
use crate::host::clipboard::ClipboardImageAvailability;
use crate::keymap::AppKeymap;
use crate::keymap::AppKeymapAction;
use crate::keymap::AppKeymapContext;
use crate::keymap::bindings;
use crate::keymap_setup::Command as KeymapCommand;
use crate::keymap_setup::Event as KeymapEvent;
use crate::keymap_setup::KeymapChoices;
use crate::keymap_setup::KeymapEditorOutcome;
use crate::marketplace::Command as MarketplaceCommand;
use crate::mcp::Command as McpCommand;
use crate::mcp::Event as McpEvent;
use crate::mcp::McpChoices;
use crate::mcp::McpSelectionAction;
use crate::models::Command as ModelCommand;
use crate::models::Event as ModelEvent;
use crate::models::ModelChoices;
use crate::models::ModelSelectionAction;
use crate::projects::Command as ProjectCommand;
use crate::projects::Event as ProjectEvent;
use crate::render::RenderContext;
use crate::render::RenderTheme;
use crate::sessions::Command as SessionCommand;
use crate::sessions::Event as SessionEvent;
use crate::sessions::SessionChoices;
use crate::sessions::SessionManagerView;
use crate::sessions::SessionScreen;
use crate::sessions::SessionSelectionAction;
use crate::sessions::SessionsState;
use crate::skills::Command as SkillCommand;
use crate::skills::Event as SkillEvent;
use crate::skills::SkillChoices;
use crate::skills::SkillDiagnosticWarnings;
use crate::skills::SkillSelectionAction;
use crate::status::Command as StatusCommand;
use crate::status::Event as StatusEvent;
use crate::status::ProcessResourcesModel;
use crate::status::StatusLineChoices;
use crate::status::StatusLineModel;
use crate::status::StatusLineRuntime;
use crate::status::StatusLineSelectionAction;
use crate::terminal::MouseMode;
use crate::theme::Command as ThemeCommand;
use crate::theme::Event as ThemeEvent;
use crate::theme::ThemeChoices;
use crate::theme::ThemePickerOutcome;
use crate::thread::AgentThreadSwitcher;
use crate::thread::AgentThreadSwitcherView;
use crate::thread::Command as ThreadCommand;
use crate::thread::CommandActivity as ThreadCommandActivity;
use crate::thread::CommandState as ThreadCommandState;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadPresentationEvent;
use crate::thread::ThreadPresentationStore;
use crate::thread::ThreadRequestIdentity;
use crate::thread::ThreadState;
use crate::thread::TurnActivity;
use crate::thread::TurnApprovalModes;
use crate::thread::composer::ChatComposerOutcome;
use crate::thread::composer::ChatComposerView;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::ChatInputItem;
use crate::thread::preview::ConversationPreview;
use crate::thread::queue::QueueId;
use crate::thread::queue::QueueView;
use crate::thread::rewind::RewindChoices;
use crate::thread::rewind::RewindSelectionAction;
use crate::thread::transcript::CellView;
use crate::thread::transcript::ChatHistoryRenderCache;
use crate::thread::transcript::ChatHistoryScroll;
use crate::thread::transcript::TranscriptScrollAnchor;
use crate::thread::transcript::TranscriptScrollDirection;
use crate::thread::transcript::first_scroll_target;
use crate::widgets::detail_list::DetailList;
use crate::widgets::detail_list::DetailListRow;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::overlay::DetailOverlay;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityKindDto;
use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_protocol::ApprovalMode;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use crossterm::event::KeyEvent;
use ratatui::layout::Rect;
use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Status {
    Ready,
    Working,
    WaitingForApproval,
    WaitingForUserInput,
    WaitingForCapability,
    Cancelling,
    Error,
}

#[derive(Debug)]
pub(crate) struct App {
    next_panel_generation: u64,
    pub(super) chat_panel: ChatPanel,
    pub(super) app_keymap: AppKeymap,
    pub(super) thread: ThreadState,
    pub(super) thread_presentations: ThreadPresentationStore,
    pub(super) sessions: SessionsState,
    welcome: WelcomeModel,
    status: Status,
    terminal_settings: TerminalSettings,
    subscriptions: [crate::config::Subscription; 2],
    selected_subscription: crate::config::SubscriptionProvider,
    pub(super) fullscreen: Fullscreen,
    pub(super) inline: super::inline::Inline,
    render_theme: RenderTheme,
    render_theme_revision: u64,
    skill_diagnostic_warnings: SkillDiagnosticWarnings,
    process_resources: ProcessResourcesModel,
    memory_diagnostics: crate::memory::Status,
    startup_context: TuiStartupContext,
}

impl App {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        let mut app = Self {
            next_panel_generation: 1,
            chat_panel: ChatPanel::new(),
            app_keymap: AppKeymap::default(),
            thread: ThreadState::default(),
            thread_presentations: ThreadPresentationStore::new(
                ash_protocol::ThreadId::new("tui-local").expect("the local Thread ID is valid"),
            ),
            sessions: SessionsState::default(),
            welcome: WelcomeModel::for_workspace(Path::new(".")),
            status: Status::Ready,
            terminal_settings: TerminalSettings::default(),
            subscriptions: [
                crate::config::Subscription::new(crate::config::SubscriptionProvider::ChatGpt),
                crate::config::Subscription::new(crate::config::SubscriptionProvider::Xai),
            ],
            selected_subscription: crate::config::SubscriptionProvider::ChatGpt,
            fullscreen: Fullscreen::new(
                ash_protocol::ThreadId::new("tui-local").expect("valid initial Thread"),
            ),
            inline: super::inline::Inline::new(
                ash_protocol::ThreadId::new("tui-local").expect("valid initial Thread"),
            ),
            render_theme: RenderTheme::fallback(),
            render_theme_revision: 0,
            skill_diagnostic_warnings: SkillDiagnosticWarnings::default(),
            process_resources: ProcessResourcesModel::default(),
            memory_diagnostics: crate::memory::Status::Disabled,
            startup_context: TuiStartupContext::new("."),
        };
        app.sessions.activate_context(
            ash_protocol::SessionId::new("tui-session").unwrap(),
            ash_protocol::ThreadId::new("tui-local").unwrap(),
        );
        app.sync_session_views();
        app.chat_panel.hide_navigation();
        app
    }

    #[cfg(test)]
    pub(crate) fn for_dir(dir_root: &Path) -> Self {
        Self::for_dir_with_input_catalog(dir_root, ChatInputCatalog::default())
    }

    #[cfg(test)]
    pub(crate) fn for_dir_with_slash_commands(
        dir_root: &Path,
        slash_commands: SlashCommandCatalog,
    ) -> Self {
        Self::for_dir_with_input_catalog(
            dir_root,
            ChatInputCatalog::with_slash_commands(slash_commands),
        )
    }

    #[cfg(test)]
    pub(crate) fn for_dir_with_input_catalog(
        dir_root: &Path,
        input_catalog: ChatInputCatalog,
    ) -> Self {
        let mut app = Self::for_dir_with_input_catalog_and_startup_context(
            dir_root,
            input_catalog,
            TuiStartupContext::new(dir_root.to_path_buf()),
        );
        app.sessions.activate_context(
            ash_protocol::SessionId::new("tui-session").unwrap(),
            ash_protocol::ThreadId::new("tui-local").unwrap(),
        );
        app.sync_session_views();
        app.chat_panel.hide_navigation();
        app
    }

    pub(crate) fn for_dir_with_input_catalog_and_startup_context(
        dir_root: &Path,
        input_catalog: ChatInputCatalog,
        startup_context: TuiStartupContext,
    ) -> Self {
        let process_resources = ProcessResourcesModel::new(startup_context.app_server_process);
        Self {
            next_panel_generation: 1,
            chat_panel: ChatPanel::new(),
            app_keymap: AppKeymap::default(),
            thread: ThreadState::default(),
            thread_presentations: ThreadPresentationStore::with_input_catalog(
                ash_protocol::ThreadId::new("tui-local").expect("the local Thread ID is valid"),
                input_catalog.clone(),
            ),
            sessions: SessionsState::new(input_catalog),
            welcome: WelcomeModel::for_workspace(dir_root),
            status: Status::Ready,
            terminal_settings: TerminalSettings::default(),
            subscriptions: [
                crate::config::Subscription::new(crate::config::SubscriptionProvider::ChatGpt),
                crate::config::Subscription::new(crate::config::SubscriptionProvider::Xai),
            ],
            selected_subscription: crate::config::SubscriptionProvider::ChatGpt,
            fullscreen: Fullscreen::new(
                ash_protocol::ThreadId::new("tui-local").expect("valid initial Thread"),
            ),
            inline: super::inline::Inline::new(
                ash_protocol::ThreadId::new("tui-local").expect("valid initial Thread"),
            ),
            render_theme: RenderTheme::fallback(),
            render_theme_revision: 0,
            skill_diagnostic_warnings: SkillDiagnosticWarnings::default(),
            process_resources,
            memory_diagnostics: crate::memory::Status::Disabled,
            startup_context,
        }
    }

    pub(crate) fn render_context(&self) -> RenderContext<'_> {
        RenderContext::new(&self.render_theme, self.render_theme_revision)
            .with_language(self.language())
    }

    pub(crate) const fn language(&self) -> crate::nls::Language {
        self.terminal_settings.language()
    }

    #[cfg(test)]
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Option<AppCommand> {
        self.handle_key_at(key, Instant::now())
    }

    #[cfg(test)]
    fn handle_key_at(&mut self, key: KeyEvent, now: Instant) -> Option<AppCommand> {
        self.handle_key_at_in_area(key, now, Rect::new(0, 0, 80, 24))
    }

    pub(crate) fn handle_key_in_area(
        &mut self,
        key: KeyEvent,
        terminal_area: Rect,
    ) -> Option<AppCommand> {
        self.handle_key_at_in_area(key, Instant::now(), terminal_area)
    }

    pub(crate) fn handle_key_at_in_area(
        &mut self,
        key: KeyEvent,
        now: Instant,
        terminal_area: Rect,
    ) -> Option<AppCommand> {
        let command = match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::handle_key(self, key, now, terminal_area)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::handle_key(self, key, now, terminal_area)
            }
        };
        self.reconcile_queue_views();
        self.sync_preview_viewports();
        command
    }

    pub(super) fn handle_chat_composer_outcome(
        &mut self,
        outcome: ChatComposerOutcome,
        now: Instant,
    ) -> Option<AppCommand> {
        match outcome {
            ChatComposerOutcome::Command(command) => {
                if !self.starts_new_session() {
                    self.thread_presentations.active_mut().queue.finish_edit();
                }
                self.handle_slash_command(command)
            }
            ChatComposerOutcome::SubmissionRejected(error) => {
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(error));
                None
            }
            ChatComposerOutcome::Queued(input) => {
                if self.starts_new_session() {
                    let submission = input.submission().clone();
                    self.sessions.pending_submission = Some(input);
                    self.sessions.creation_error = None;
                    return Some(SessionCommand::CreateAndEnter { submission }.into());
                }
                let queue = &mut self.thread_presentations.active_mut().queue;
                let id = queue.push(input);
                queue.submit(id).map(Into::into)
            }
            ChatComposerOutcome::Submit(submission) => {
                if self.starts_new_session() {
                    return Some(SessionCommand::CreateAndEnter { submission }.into());
                }
                let queue = &mut self.thread_presentations.active_mut().queue;
                if queue.is_editing() {
                    let id = queue.push(crate::thread::composer::QueuedChatInput::from_submission(
                        submission,
                    ));
                    return queue.submit(id).map(Into::into);
                }
                self.follow_latest_transcript();
                self.thread_presentations.active_mut().queue.finish_edit();
                let starts_conversation = !self.thread.has_user_message();
                self.thread.update(ThreadPresentationEvent::UserSubmitted(
                    submission.display_text.clone(),
                ));
                if starts_conversation {
                    self.chat_panel.show_policy_tip(now);
                }
                if self.chat_panel.is_steering() {
                    let steer_id = self.chat_panel.begin_steer(submission.display_text.clone());
                    return Some(
                        ThreadCommand::SteerTurn {
                            steer_id,
                            submission,
                        }
                        .into(),
                    );
                }
                self.set_status(Status::Working);
                self.chat_panel.queue_input();
                Some(ThreadCommand::SubmitTurn { submission }.into())
            }
            ChatComposerOutcome::Consumed => None,
            ChatComposerOutcome::Unhandled => None,
        }
    }

    pub(super) fn send_queued_message(&mut self, queue_id: QueueId) -> Option<AppCommand> {
        if matches!(self.status, Status::Working) && !self.chat_panel.is_steering() {
            self.thread.update(ThreadPresentationEvent::FailureReported(
                "wait until the active Turn can accept steering".into(),
            ));
            return None;
        }
        let turn = self.active_turn().cloned();
        let queue = &mut self.thread_presentations.active_mut().queue;
        match queue.target(queue_id) {
            Some(target) => Some(
                ThreadCommand::EditQueue {
                    target,
                    action: crate::thread::queue::QueueAction::Send(turn),
                }
                .into(),
            ),
            None => queue.submit(queue_id).map(Into::into),
        }
    }

    pub(super) fn handle_thread_request_key(
        &mut self,
        key: KeyEvent,
    ) -> Option<Option<AppCommand>> {
        self.chat_panel
            .handle_request_key(key)
            .map(|response| response.map(|response| ThreadCommand::ResolveRequest(response).into()))
    }

    pub(super) fn activate_approval(&mut self, index: usize) -> Option<AppCommand> {
        self.chat_panel
            .activate_approval(index)
            .map(|response| ThreadCommand::ResolveRequest(response).into())
    }

    pub(super) fn activate_query_choice(&mut self, index: usize) -> Option<AppCommand> {
        self.chat_panel
            .activate_query_choice(index)
            .map(|response| ThreadCommand::ResolveRequest(response).into())
    }

    fn close_thread_request(&mut self, request: &ThreadRequestIdentity) {
        self.chat_panel.close_request(request);
    }

    fn fail_thread_request(&mut self, request: &ThreadRequestIdentity, error: String) {
        self.chat_panel.fail_request(request, error);
    }

    pub(super) fn handle_command_panel_outcome(
        &mut self,
        outcome: CommandPanelOutcome,
    ) -> Option<AppCommand> {
        match outcome {
            CommandPanelOutcome::Dirs(DirSelectionAction::Add {
                request_id,
                path,
                target: DirAddTarget::Session,
            }) => Some(DirCommand::Add { request_id, path }.into()),
            CommandPanelOutcome::Dirs(DirSelectionAction::Add {
                request_id,
                path,
                target: DirAddTarget::Project,
            }) => Some(ProjectCommand::AddRoot { request_id, path }.into()),
            CommandPanelOutcome::Dirs(DirSelectionAction::Remove { path }) => {
                Some(DirCommand::Remove { path }.into())
            }
            CommandPanelOutcome::Dirs(DirSelectionAction::SetPermissions(params)) => {
                Some(DirCommand::SetPermissions(params).into())
            }
            CommandPanelOutcome::Config(outcome) => self.handle_config_editor_outcome(outcome),
            CommandPanelOutcome::Connectors(ConnectorSelectionAction::ConnectDeviceOAuth {
                connector_id,
                connection_generation,
            }) => Some(
                ConnectorCommand::ConnectDeviceOAuth {
                    connector_id,
                    connection_generation,
                }
                .into(),
            ),
            CommandPanelOutcome::Connectors(ConnectorSelectionAction::Disconnect {
                connector_id,
            }) => Some(ConnectorCommand::Disconnect { connector_id }.into()),
            CommandPanelOutcome::Keymap(KeymapEditorOutcome::Edit(edit)) => {
                Some(KeymapCommand::Edit(edit).into())
            }
            CommandPanelOutcome::Keymap(KeymapEditorOutcome::Consumed) => None,
            CommandPanelOutcome::Keymap(KeymapEditorOutcome::Dismiss) => {
                self.close_command_panel();
                None
            }
            CommandPanelOutcome::Mcp(McpSelectionAction::SetEnablement {
                server_id,
                enablement,
            }) => Some(
                McpCommand::SetEnablement {
                    server_id,
                    enablement,
                }
                .into(),
            ),
            CommandPanelOutcome::Model(ModelSelectionAction::Select { preference, .. }) => {
                Some(ModelCommand::SetModel { preference }.into())
            }
            CommandPanelOutcome::Model(ModelSelectionAction::Pin { preference, pinned }) => {
                Some(ModelCommand::Pin { preference, pinned }.into())
            }
            CommandPanelOutcome::GitBranch(action) => {
                if action.current {
                    self.close_command_panel();
                    None
                } else {
                    Some(GitCommand::Switch { name: action.name }.into())
                }
            }
            CommandPanelOutcome::ProjectRoot(action) => match action {
                crate::projects::RootSelectionAction::Switch { path, current } => {
                    self.close_command_panel();
                    if current {
                        None
                    } else {
                        Some(crate::dirs::Command::MoveSession { path }.into())
                    }
                }
                crate::projects::RootSelectionAction::Add => {
                    self.open_command_panel(CommandPanel::loading(
                        "Add project folder",
                        "Loading directory permissions…",
                    ));
                    Some(crate::projects::Command::OpenAddRoot.into())
                }
            },
            CommandPanelOutcome::Rewind(RewindSelectionAction::Rewind {
                before_turn_id,
                checkpoint_label,
            }) => Some(
                ThreadCommand::RewindToCheckpoint {
                    before_turn_id,
                    checkpoint_label,
                }
                .into(),
            ),
            CommandPanelOutcome::Rewind(RewindSelectionAction::RestoreMessage {
                item_id,
                boundary,
                checkpoint_label,
            }) => Some(
                ThreadCommand::RestoreMessage {
                    item_id,
                    boundary,
                    checkpoint_label,
                }
                .into(),
            ),
            CommandPanelOutcome::Sessions(SessionSelectionAction::Resume { session_id }) => Some(
                SessionCommand::Resume {
                    session_id,
                    preferred_thread_id: None,
                }
                .into(),
            ),
            CommandPanelOutcome::Marketplace(command) => Some(command.into()),
            CommandPanelOutcome::Lsp(crate::lsp::Outcome::Command(command)) => Some(command.into()),
            CommandPanelOutcome::Lsp(crate::lsp::Outcome::Marketplace(command)) => {
                Some(command.into())
            }
            CommandPanelOutcome::Lsp(crate::lsp::Outcome::Consumed) => None,
            CommandPanelOutcome::Lsp(crate::lsp::Outcome::Dismiss) => {
                self.close_command_panel();
                None
            }
            CommandPanelOutcome::Memories(command) => Some(command.into()),
            CommandPanelOutcome::Skills(SkillSelectionAction::SetEnablement {
                skill_id,
                enablement,
            }) => Some(
                SkillCommand::SetEnablement {
                    skill_id,
                    enablement,
                }
                .into(),
            ),
            CommandPanelOutcome::StatusLine(StatusLineSelectionAction::SetEnabled(edit)) => {
                Some(StatusCommand::EditLine(edit).into())
            }
            CommandPanelOutcome::Theme(outcome) => self.handle_theme_picker_outcome(outcome),
            CommandPanelOutcome::Skills(SkillSelectionAction::Marketplace) => {
                Some(MarketplaceCommand::browse(Some(MarketplaceCapabilityKindDto::Skill)).into())
            }
            CommandPanelOutcome::Mcp(McpSelectionAction::Marketplace) => {
                Some(MarketplaceCommand::browse(Some(MarketplaceCapabilityKindDto::Mcp)).into())
            }
            CommandPanelOutcome::Connectors(ConnectorSelectionAction::Marketplace) => Some(
                MarketplaceCommand::browse(Some(MarketplaceCapabilityKindDto::Connector)).into(),
            ),
            CommandPanelOutcome::Consumed => None,
            CommandPanelOutcome::Dismiss => {
                self.close_command_panel();
                None
            }
        }
    }

    fn handle_config_editor_outcome(
        &mut self,
        outcome: crate::config::ConfigEditorOutcome,
    ) -> Option<AppCommand> {
        match outcome {
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::OpenAdvisor) => {
                Some(ConfigCommand::OpenAdvisor.into())
            }
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::SetAdvisor(
                config,
            )) => Some(ConfigCommand::SetAdvisor(config).into()),
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::SetMemories(
                edit,
            )) => Some(ConfigCommand::SetMemories(edit).into()),
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::SetGitMode(edit) | ConfigSelectionAction::SetGitPeriod(edit),
            ) => Some(ConfigCommand::SetGit(edit).into()),
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::SetIssues(edit)
                | ConfigSelectionAction::AdjustIssueRefresh(edit),
            ) => Some(ConfigCommand::SetIssues(edit).into()),

            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(
                request,
            )) => Some(ConfigCommand::Connection(request).into()),
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::OpenProvider(_)) => {
                None
            }
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::OpenSubscription(provider),
            ) => {
                self.selected_subscription = provider;
                let mut choices = self.subscriptions[self.selected_subscription.index()].choices();
                self.localize_selection(&mut choices);
                self.panels_mut().open_subscription(choices);
                self.begin_subscription_command(crate::config::SubscriptionCommand::Read)
            }
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::Subscription(
                command,
            )) => self.begin_subscription_command(command),
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::SetTerminalSettings(edit)
                | ConfigSelectionAction::SetUpdatePolicy(edit),
            ) => Some(ConfigCommand::Edit(edit).into()),
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::SetVimMode(edit)) => {
                Some(ConfigCommand::Edit(edit).into())
            }
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::SetShowGitChangesAsDiff(edit)
                | ConfigSelectionAction::SetStatusLineStyle(edit),
            ) => Some(ConfigCommand::Edit(edit).into()),
            crate::config::ConfigEditorOutcome::Action(ConfigSelectionAction::SetLanguage(
                edit,
            )) => Some(ConfigCommand::Edit(edit).into()),
            crate::config::ConfigEditorOutcome::Action(
                ConfigSelectionAction::OpenProviderApiKey { .. },
            ) => None,
            crate::config::ConfigEditorOutcome::SaveApiKey(edit) => {
                Some(ConfigCommand::SetProviderApiKey(edit).into())
            }
            crate::config::ConfigEditorOutcome::Consumed => None,
            crate::config::ConfigEditorOutcome::Dismiss => {
                self.close_command_panel();
                None
            }
        }
    }

    fn begin_subscription_command(
        &mut self,
        command: crate::config::SubscriptionCommand,
    ) -> Option<AppCommand> {
        if !self.subscriptions[self.selected_subscription.index()].begin(&command) {
            return None;
        }
        let mut choices = self.subscriptions[self.selected_subscription.index()].choices();
        self.localize_selection(&mut choices);
        self.panels_mut().update_subscription(choices);
        Some(ConfigCommand::Subscription(self.selected_subscription, command).into())
    }

    fn handle_theme_picker_outcome(&mut self, outcome: ThemePickerOutcome) -> Option<AppCommand> {
        match outcome {
            ThemePickerOutcome::Select { preference } => {
                self.close_command_panel();
                Some(ThemeCommand::Set { preference }.into())
            }
            ThemePickerOutcome::SelectCustom { preference } => {
                self.close_command_panel();
                Some(ThemeCommand::SetCustom { preference }.into())
            }
            ThemePickerOutcome::OpenCustomThemes => Some(ThemeCommand::OpenCustomPicker.into()),
            ThemePickerOutcome::Consumed => None,
            ThemePickerOutcome::Dismiss => {
                self.close_command_panel();
                None
            }
        }
    }

    pub(crate) fn activate_input_completion(&mut self, index: usize) -> Option<AppCommand> {
        if !self.accepts_input() {
            return None;
        }
        let (panel, input) = self.composer_parts_mut();
        let outcome = panel.activate_completion(input, index)?;
        self.handle_chat_composer_outcome(outcome, Instant::now())
    }

    pub(crate) fn open_transcript_cell_details(&mut self, render_key: &str) -> bool {
        let cell_id = crate::thread::TranscriptCellId::from_render_key(render_key);
        let Some(details) = self.thread.details(&cell_id) else {
            return false;
        };
        self.viewport_mut().selected_cell = Some(cell_id);
        self.show_overlay(DetailList::new(
            "Transcript cell",
            vec![DetailListRow::new("Content", details)],
        ));
        true
    }

    pub(crate) fn replace_chat_input_catalog(&mut self, catalog: ChatInputCatalog) {
        self.sessions.input.replace_catalog(catalog.clone());
        self.thread_presentations.replace_input_catalog(catalog);
    }

    pub(crate) fn insert_text(&mut self, text: &str) {
        if self.accepts_input() {
            let (panel, input) = self.composer_parts_mut();
            panel.insert_text(input, text);
            self.dismiss_fullscreen_welcome_on_input();
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        self.fullscreen.pointer.clear();
        if self.overlay().is_some() || self.session_navigation().preview.is_some() {
            return;
        }
        if self.screen_mode() == crate::terminal::ScreenMode::Fullscreen
            && self.panels().command_active()
        {
            self.panels_mut().handle_command_paste(pasted);
            return;
        }
        if self.issues().is_open() {
            self.issues_mut().handle_paste(pasted);
            return;
        }
        if !self.fullscreen_home_visible()
            && matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Session(_))
            )
            && self.chat_panel.request_active()
        {
            self.chat_panel.handle_request_paste(pasted);
            return;
        }
        if self.panels().command_active() {
            self.panels_mut().handle_command_paste(pasted);
            return;
        }
        if self.accepts_input() && self.chat_input_focused() && !self.queue_focused() {
            let (panel, input) = self.composer_parts_mut();
            if let Err(error) = panel.handle_input_paste(input, pasted) {
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(error));
            }
            self.dismiss_fullscreen_welcome_on_input();
        }
    }

    pub(super) fn draft_target(&self) -> crate::thread::composer::DraftTarget {
        let generation = self.input_state().generation();
        if self.starts_new_session() {
            crate::thread::composer::DraftTarget::NewSession { generation }
        } else {
            crate::thread::composer::DraftTarget::Thread {
                thread_id: self.thread_presentations.active_id().clone(),
                generation,
            }
        }
    }

    fn attach_clipboard_image(
        &mut self,
        target: crate::thread::composer::DraftTarget,
        result: Result<ClipboardImage, String>,
    ) {
        let visible = self.draft_target() == target;
        let (input, generation) = match &target {
            crate::thread::composer::DraftTarget::NewSession { generation } => {
                (&mut self.sessions.input, *generation)
            }
            crate::thread::composer::DraftTarget::Thread {
                thread_id,
                generation,
            } => {
                let Some(input) = self.thread_presentations.input_mut(thread_id) else {
                    return;
                };
                (input, *generation)
            }
        };
        if input.generation() != generation {
            return;
        }
        match result {
            Ok(image) => match self.chat_panel.attach_image_bytes(input, image.png) {
                Ok(()) if visible => self.chat_panel.clipboard_image_pasted(image.fingerprint),
                Err(error) if visible => self.record_clipboard_error(error),
                _ => {}
            },
            Err(error) if visible => self.record_clipboard_error(error),
            Err(_) => {}
        }
        self.dismiss_fullscreen_welcome_on_input();
    }

    fn record_clipboard_error(&mut self, error: String) {
        if self.accepts_input() {
            self.thread
                .update(ThreadPresentationEvent::FailureReported(format!(
                    "could not paste clipboard image: {error}"
                )));
        }
    }

    pub(crate) fn connect_input_history(&mut self, client: message_history::MessageHistory) {
        self.sessions
            .input
            .connect_new_session_history(client.clone());
        self.thread_presentations.connect_history(client);
    }

    pub(crate) fn recovery_drafts(&self) -> crate::TuiRecoveryDrafts {
        crate::TuiRecoveryDrafts {
            new_session: Some(self.sessions.input.recovery_draft()),
            threads: self.thread_presentations.recovery_drafts(),
            home_visible: self.fullscreen_home_visible(),
        }
    }

    pub(crate) fn restore_recovery_drafts(&mut self, drafts: crate::TuiRecoveryDrafts) {
        if let Some(draft) = drafts.new_session {
            self.sessions.input.restore_recovery_draft(draft);
        }
        self.thread_presentations
            .restore_recovery_drafts(drafts.threads);
        if drafts.home_visible {
            self.open_home();
        }
    }

    pub(crate) fn input_history_unavailable(&mut self, error: String) {
        self.sessions.input.history_unavailable(error.clone());
        self.thread_presentations.history_unavailable(error);
    }

    pub(crate) fn poll_input_history(&mut self) -> bool {
        self.sessions.input.poll_history() | self.thread_presentations.poll_history()
    }

    pub(crate) fn input(&self) -> &str {
        self.input_state().text()
    }

    pub(crate) fn chat_composer_view(&self) -> ChatComposerView<'_> {
        self.chat_panel.composer_view(self.input_state())
    }

    pub(super) fn session_navigation(&self) -> &crate::sessions::SessionNavigation {
        self.session_navigation_in(self.screen_mode())
    }

    pub(super) fn session_navigation_mut(&mut self) -> &mut crate::sessions::SessionNavigation {
        self.session_navigation_in_mut(self.screen_mode())
    }

    pub(super) fn session_navigation_in(
        &self,
        mode: crate::terminal::ScreenMode,
    ) -> &crate::sessions::SessionNavigation {
        match mode {
            crate::terminal::ScreenMode::Fullscreen => &self.fullscreen.sessions,
            crate::terminal::ScreenMode::Inline => &self.inline.sessions,
        }
    }

    pub(super) fn session_navigation_in_mut(
        &mut self,
        mode: crate::terminal::ScreenMode,
    ) -> &mut crate::sessions::SessionNavigation {
        match mode {
            crate::terminal::ScreenMode::Fullscreen => &mut self.fullscreen.sessions,
            crate::terminal::ScreenMode::Inline => &mut self.inline.sessions,
        }
    }

    pub(super) fn issues(&self) -> &crate::issues::Manager {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &self.fullscreen.issues,
            crate::terminal::ScreenMode::Inline => &self.inline.issues,
        }
    }

    pub(super) fn issues_mut(&mut self) -> &mut crate::issues::Manager {
        self.issues_in_mut(self.screen_mode())
    }

    pub(super) fn issues_in_mut(
        &mut self,
        mode: crate::terminal::ScreenMode,
    ) -> &mut crate::issues::Manager {
        match mode {
            crate::terminal::ScreenMode::Fullscreen => &mut self.fullscreen.issues,
            crate::terminal::ScreenMode::Inline => &mut self.inline.issues,
        }
    }

    pub(super) fn agent_thread_switcher(&self) -> &AgentThreadSwitcher {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &self.fullscreen.agent_thread_switcher,
            crate::terminal::ScreenMode::Inline => &self.inline.agent_thread_switcher,
        }
    }

    pub(super) fn agent_thread_switcher_mut(&mut self) -> &mut AgentThreadSwitcher {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &mut self.fullscreen.agent_thread_switcher,
            crate::terminal::ScreenMode::Inline => &mut self.inline.agent_thread_switcher,
        }
    }

    pub(super) fn escape_mut(&mut self) -> &mut ScreenEscapeSequence {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &mut self.fullscreen.escape,
            crate::terminal::ScreenMode::Inline => &mut self.inline.escape,
        }
    }

    pub(super) fn new_panel_generation(&mut self) -> u64 {
        let generation = self.next_panel_generation;
        self.next_panel_generation = self
            .next_panel_generation
            .checked_add(1)
            .expect("panel identities are not reused");
        generation
    }

    pub(super) fn panels(&self) -> &super::command_panel::Panels {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &self.fullscreen.panels,
            crate::terminal::ScreenMode::Inline => &self.inline.panels,
        }
    }

    pub(super) fn panels_mut(&mut self) -> &mut super::command_panel::Panels {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => &mut self.fullscreen.panels,
            crate::terminal::ScreenMode::Inline => &mut self.inline.panels,
        }
    }

    fn set_terminal_settings(&mut self, settings: TerminalSettings) {
        if self.screen_mode() != settings.screen_mode() {
            let editor = self.panels_mut().take_editor();
            self.terminal_settings = settings;
            self.panels_mut().receive_editor(editor);
            self.fullscreen.clear();
            self.fullscreen.escape.reset();
            self.inline.escape.reset();
            self.reconcile_transcript_scroll_anchor();
        } else {
            self.terminal_settings = settings;
        }
    }

    pub(crate) fn command_panel_key_hints(&self) -> Option<&crate::widgets::key_hint::KeyHints> {
        self.panels().command_key_hints()
    }

    pub(crate) fn command_panel(&self) -> Option<&CommandPanel> {
        self.panels().command()
    }

    pub(super) fn take_session_details_request(
        &mut self,
    ) -> Option<(u64, ash_protocol::SessionId)> {
        self.session_navigation_mut()
            .details
            .as_mut()
            .and_then(|details| details.take_request())
    }

    pub(super) fn overlay_mut(&mut self) -> Option<&mut DetailOverlay> {
        if self.panels().overlay.is_some() {
            return self.panels_mut().overlay.as_mut();
        }
        self.session_navigation_mut()
            .details
            .as_mut()
            .map(|details| &mut details.overlay)
    }

    pub(crate) fn overlay(&self) -> Option<&DetailOverlay> {
        self.panels().overlay.as_ref().or_else(|| {
            self.session_navigation()
                .details
                .as_ref()
                .map(|details| &details.overlay)
        })
    }

    pub(crate) fn completion(&self) -> Option<CompletionView<'_>> {
        if self.panels().command_active() || self.overlay().is_some() || self.queue_focused() {
            return None;
        }
        self.input_state().completion()
    }

    pub(crate) fn completion_visible(&self) -> bool {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::completion_visible(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::completion_visible(self)
            }
        }
    }

    pub(crate) fn chat_input_focused(&self) -> bool {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::chat_input_focused(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::chat_input_focused(self)
            }
        }
    }

    pub(crate) fn queue_focused(&self) -> bool {
        !self.starts_new_session()
            && !self.issues().is_open()
            && self.session_preview().is_none()
            && self
                .viewport()
                .queue
                .focused(&self.thread_presentations.active().queue)
    }

    pub(crate) fn queue_key_hints(&self) -> &'static crate::widgets::key_hint::KeyHints {
        &bindings::QUEUE_HINTS
    }

    pub(crate) fn mouse_mode(&self) -> MouseMode {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => MouseMode::TuiCapture,
            crate::terminal::ScreenMode::Inline => MouseMode::TerminalSelection,
        }
    }

    pub(crate) const fn screen_mode(&self) -> crate::terminal::ScreenMode {
        self.terminal_settings.screen_mode()
    }

    pub(crate) const fn key_hint_style(&self) -> crate::config::KeyHintStyle {
        self.terminal_settings.key_hint_style()
    }

    pub(crate) fn fullscreen_home_visible(&self) -> bool {
        self.screen_mode() == crate::terminal::ScreenMode::Fullscreen
            && self.fullscreen.home_visible()
    }

    pub(crate) fn fullscreen_welcome_visible(&self) -> bool {
        self.screen_mode() == crate::terminal::ScreenMode::Fullscreen
            && self.fullscreen.welcome_visible()
    }

    fn dismiss_fullscreen_welcome_on_input(&mut self) {
        let input = self.input_state();
        let draft_started = !input.text().is_empty() || !input.is_empty();
        if self.fullscreen_welcome_visible() && draft_started {
            self.fullscreen.dismiss_welcome();
        }
    }

    pub(super) fn starts_new_session(&self) -> bool {
        self.fullscreen_home_visible()
            || self.sessions.active_session_id().is_none()
            || matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Manager)
            )
    }

    pub(super) fn input_state(&self) -> &crate::thread::composer::ChatInput {
        if self.starts_new_session() {
            &self.sessions.input
        } else {
            &self.thread_presentations.active().input
        }
    }

    fn composer_parts_mut(&mut self) -> (&mut ChatPanel, &mut crate::thread::composer::ChatInput) {
        if self.starts_new_session() {
            (&mut self.chat_panel, &mut self.sessions.input)
        } else {
            (
                &mut self.chat_panel,
                &mut self.thread_presentations.active_mut().input,
            )
        }
    }

    pub(super) fn handle_composer_key(&mut self, key: KeyEvent) -> ChatComposerOutcome {
        let new_session = self.starts_new_session();
        let (panel, input) = self.composer_parts_mut();
        let outcome = if new_session {
            panel.handle_new_session_key(input, key)
        } else {
            panel.handle_composer_key(input, key)
        };
        self.dismiss_fullscreen_welcome_on_input();
        outcome
    }

    pub(super) fn open_home(&mut self) {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::open_home(self)
            }
            crate::terminal::ScreenMode::Inline => super::inline::navigation::open_home(self),
        }
    }

    pub(super) fn show_conversation(&mut self) {
        self.show_conversation_in(self.screen_mode());
    }

    pub(super) fn show_conversation_in(&mut self, mode: crate::terminal::ScreenMode) {
        let Some(session_id) = self.sessions.active_session_id().cloned() else {
            return;
        };
        match mode {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::show_conversation(self, session_id)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::show_conversation(self, session_id)
            }
        }
    }

    pub(super) fn show_session_manager(&mut self) {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::show_manager(self)
            }
            crate::terminal::ScreenMode::Inline => super::inline::navigation::show_manager(self),
        }
    }

    fn open_issues(&mut self) -> Option<AppCommand> {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::open_issues(self)
            }
            crate::terminal::ScreenMode::Inline => super::inline::navigation::open_issues(self),
        }
    }

    fn sync_session_views(&mut self) {
        self.fullscreen.sessions.context_changed(&self.sessions);
        self.inline.sessions.context_changed(&self.sessions);
    }

    pub(super) fn fail_session_creation(&mut self, error: String) {
        if let Some(draft) = self.sessions.pending_submission.take() {
            self.sessions
                .input
                .restore_queued(draft)
                .expect("the new-session draft is locked until its request finishes");
            self.chat_panel.show_notice(error.clone(), Instant::now());
            self.sessions.creation_error = Some(error);
        } else {
            self.update(ThreadEvent::FailureReported(error));
        }
    }

    pub(crate) fn screen_thread_id(&self) -> &ash_protocol::ThreadId {
        self.thread_presentations.active_id()
    }

    pub(crate) fn history_prefix(&self) -> &[crate::thread::transcript::TranscriptCell] {
        self.thread.history_prefix()
    }

    pub(super) const fn memory_diagnostics_enabled(&self) -> bool {
        self.terminal_settings.memory_diagnostics()
    }

    #[cfg(test)]
    fn show_help(&mut self, model: crate::widgets::list_selection::ListSelectionModel) {
        self.open_command_panel(CommandPanel::help(model));
    }

    pub(crate) fn approval_view(
        &self,
    ) -> Option<crate::thread::interaction::approval::ApprovalView<'_>> {
        (!self.fullscreen_home_visible()
            && matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Session(_))
            ))
        .then(|| self.chat_panel.approval_view())
        .flatten()
    }

    pub(crate) fn query_view(&self) -> Option<crate::thread::interaction::query::QueryView<'_>> {
        (!self.fullscreen_home_visible()
            && matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Session(_))
            ))
        .then(|| self.chat_panel.query_view())
        .flatten()
    }

    pub(crate) fn transcript_selection_active(&self) -> bool {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::transcript_selection_active(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::transcript_selection_active(self)
            }
        }
    }

    pub(super) fn open_command_panel(&mut self, mut panel: CommandPanel) {
        panel.localize(self.language());
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::open_command_panel(self, panel)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::open_command_panel(self, panel)
            }
        }
    }

    pub(super) fn close_command_panel(&mut self) {
        if let Some(CommandPanel::Memories(panel)) = self.panels_mut().command_mut() {
            if !panel.close() {
                return;
            }
        }
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::close_command_panel(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::close_command_panel(self)
            }
        }
    }

    pub(super) fn show_overlay(&mut self, detail: DetailList) {
        self.show_overlay_in(self.screen_mode(), detail);
    }

    pub(super) fn show_overlay_in(
        &mut self,
        mode: crate::terminal::ScreenMode,
        mut detail: DetailList,
    ) {
        detail.localize(self.language());
        match mode {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::show_overlay(self, detail)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::show_overlay(self, detail)
            }
        }
    }

    pub(super) fn close_transient_surfaces(&mut self) {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::close_transient_surfaces(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::close_transient_surfaces(self)
            }
        }
    }

    fn show_dirs_picker(&mut self, spec: DirChoices) {
        self.open_command_panel(CommandPanel::dirs(spec));
    }

    fn update_dirs_picker(&mut self, spec: DirChoices) {
        self.panels_mut().replace_dirs(spec);
    }

    fn show_skill_settings(&mut self, choices: SkillChoices) {
        let SkillChoices {
            model,
            actions,
            diagnostics,
        } = choices;
        self.report_skill_diagnostics(&diagnostics);
        self.open_command_panel(CommandPanel::skills(SkillChoices {
            model,
            actions,
            diagnostics: Vec::new(),
        }));
    }

    fn show_mcp_settings(&mut self, spec: McpChoices) {
        self.open_command_panel(CommandPanel::mcp(spec));
    }

    fn show_connector_picker(&mut self, spec: ConnectorChoices) {
        self.open_command_panel(CommandPanel::connectors(spec));
    }

    fn update_connector_picker(&mut self, mut spec: ConnectorChoices) {
        self.localize_selection(&mut spec);
        self.panels_mut().replace_connectors(spec);
    }

    pub(crate) fn connector_picker_open(&self) -> bool {
        self.panels().command_is_connectors()
    }

    fn update_mcp_settings(&mut self, mut spec: McpChoices) {
        self.localize_selection(&mut spec);
        self.panels_mut().replace_mcp(spec);
    }

    fn show_model_picker(&mut self, spec: ModelChoices) {
        self.open_command_panel(CommandPanel::model(spec));
    }

    fn show_rewind_picker(&mut self, spec: RewindChoices) {
        self.open_command_panel(CommandPanel::rewind(spec));
    }

    fn show_session_picker(&mut self, spec: SessionChoices) {
        self.open_command_panel(CommandPanel::sessions(spec));
    }

    fn update_skill_settings(&mut self, choices: SkillChoices) {
        let SkillChoices {
            model,
            actions,
            diagnostics,
        } = choices;
        self.report_skill_diagnostics(&diagnostics);
        let mut choices = SkillChoices {
            model,
            actions,
            diagnostics: Vec::new(),
        };
        choices.model.localize(self.language());
        self.panels_mut().replace_skills(choices);
    }

    fn report_skill_diagnostics(
        &mut self,
        diagnostics: &[ash_app_server_protocol::protocol::skills::SkillDiagnosticDto],
    ) {
        for notice in self.skill_diagnostic_warnings.update(diagnostics) {
            self.thread
                .update(ThreadPresentationEvent::NoticeReceived(notice));
        }
    }

    fn show_theme_picker(&mut self, spec: ThemeChoices) {
        self.open_command_panel(CommandPanel::theme(spec));
    }

    fn show_keymap_editor(&mut self, spec: KeymapChoices) {
        self.open_command_panel(CommandPanel::keymap(spec));
    }

    fn show_status_line_editor(&mut self, spec: StatusLineChoices) {
        self.open_command_panel(CommandPanel::status_line(spec));
    }

    fn show_status_panel(&mut self, mut panel: crate::status::StatusPanel) {
        panel.apply_process_resources(self.process_resources.view());
        self.open_command_panel(CommandPanel::status(panel));
    }

    fn show_startup_panel(&mut self) {
        let context = self.startup_context.clone();
        self.open_command_panel(CommandPanel::startup(&context));
    }

    fn update_status_line_editor(&mut self, mut spec: StatusLineChoices) {
        self.localize_selection(&mut spec);
        self.panels_mut().replace_status_line(spec);
    }

    fn localize_selection<A>(&self, spec: &mut ListSelectionSpec<A>) {
        spec.model.localize(self.language());
    }

    pub(crate) fn skills_view_is_active(&self) -> bool {
        self.panels().command_is_skills()
    }

    pub(crate) fn list_selection(&self) -> Option<&ListSelectionState> {
        self.panels().command_list_selection()
    }

    pub(crate) fn mention_query(&self) -> Option<&str> {
        if self.panels().command_active() {
            return None;
        }
        self.input_state().mention_query()
    }

    #[cfg(test)]
    pub(crate) fn messages(&self) -> Vec<CellView<'_>> {
        self.thread.messages()
    }

    pub(crate) fn transcript_views(&self) -> Vec<CellView<'_>> {
        self.thread.views(
            &self.viewport().expanded_cells,
            self.viewport().selected_cell.as_ref(),
        )
    }

    pub(crate) fn stream_deadline(&self) -> Option<Instant> {
        self.thread.stream_deadline()
    }

    pub(crate) fn advance_stream(&mut self, now: Instant) -> bool {
        self.thread.advance_stream(now)
    }

    pub(crate) fn visible_transcript_views(&self) -> Vec<CellView<'_>> {
        self.thread.visible_views(
            &self.viewport().expanded_cells,
            self.viewport().selected_cell.as_ref(),
        )
    }

    pub(crate) fn latest_agent_response(&self) -> Option<&str> {
        self.thread.latest_agent_response()
    }

    pub(crate) fn transcript_markdown(&self) -> String {
        crate::thread::transcript::export_markdown(&self.transcript_views())
    }

    pub(super) fn viewport(&self) -> &crate::thread::transcript::viewport::Viewport {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => self.fullscreen.viewports.active(),
            crate::terminal::ScreenMode::Inline => self.inline.viewports.active(),
        }
    }

    pub(super) fn viewport_mut(&mut self) -> &mut crate::thread::transcript::viewport::Viewport {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => self.fullscreen.viewports.active_mut(),
            crate::terminal::ScreenMode::Inline => self.inline.viewports.active_mut(),
        }
    }

    pub(crate) fn transcript_scroll(&self) -> &ChatHistoryScroll {
        &self.viewport().scroll
    }

    pub(crate) fn navigate_transcript(
        &mut self,
        direction: TranscriptScrollDirection,
        terminal_area: Rect,
    ) -> Option<AppCommand> {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::navigate_transcript(self, direction, terminal_area)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::navigate_transcript(self, direction, terminal_area)
            }
        }
    }

    pub(crate) fn follow_latest_transcript(&mut self) {
        if self.session_navigation().preview.is_some() {
            match self.screen_mode() {
                crate::terminal::ScreenMode::Fullscreen => {
                    self.fullscreen.preview.scroll.follow_latest()
                }
                crate::terminal::ScreenMode::Inline => self.inline.preview.scroll.follow_latest(),
            }
            return;
        }
        self.viewport_mut().scroll.follow_latest();
    }

    pub(crate) fn transcript_render_cache(&self) -> &ChatHistoryRenderCache {
        &self.viewport().render_cache
    }

    pub(crate) fn welcome(&self) -> &WelcomeModel {
        &self.welcome
    }

    pub(crate) fn workspace_switch_available(&self) -> bool {
        self.startup_context.connection == crate::TuiConnectionKind::Local
    }

    pub(crate) fn workspace_mutation_available(&self) -> bool {
        self.active_turn().is_none()
            && self.sessions.pending_submission.is_none()
            && matches!(self.status, Status::Ready | Status::Error)
    }

    pub(crate) fn memory_object_count(&self) -> usize {
        self.thread.cells().len()
    }

    #[cfg(test)]
    pub(crate) fn status(&self) -> &Status {
        &self.status
    }

    pub(crate) fn thread_command_state(&self) -> ThreadCommandState {
        let activity = match self.status {
            Status::Ready => ThreadCommandActivity::Ready,
            Status::Working => ThreadCommandActivity::Working,
            Status::Error => ThreadCommandActivity::Error,
            Status::WaitingForApproval
            | Status::WaitingForUserInput
            | Status::WaitingForCapability
            | Status::Cancelling => ThreadCommandActivity::Other,
        };
        ThreadCommandState::new(
            self.active_turn().cloned(),
            self.approval_mode(),
            activity,
            self.steers_active_turn(),
        )
    }

    fn set_status(&mut self, status: Status) {
        let timer = &mut self.thread_presentations.active_mut().status_timer;
        match status {
            Status::Ready | Status::Error => timer.clear(),
            _ => timer.start(Instant::now()),
        }
        self.status = status;
    }

    pub(crate) fn status_indicator(
        &self,
    ) -> Option<crate::thread::status_indicator::StatusIndicator<'_>> {
        if self.session_manager_view().is_some()
            || self.issue_manager().is_some()
            || self.session_preview().is_some()
            || self.command_panel().is_some()
        {
            return None;
        }
        let activity = match self.status {
            Status::Ready | Status::Error => return None,
            Status::Working if self.active_turn().is_none() => TurnActivity::Starting,
            Status::Working => TurnActivity::Working,
            Status::WaitingForApproval => TurnActivity::WaitingForApproval,
            Status::WaitingForUserInput => TurnActivity::WaitingForUserInput,
            Status::WaitingForCapability => TurnActivity::WaitingForCapability,
            Status::Cancelling => TurnActivity::Cancelling,
        };
        let interrupt_hint = if self.active_turn().is_some() && self.status != Status::Cancelling {
            self.app_keymap.action_hint(
                AppKeymapAction::InterruptOrQuit,
                self.app_keymap_context(true),
            )
        } else {
            None
        };
        Some(crate::thread::status_indicator::StatusIndicator {
            activity,
            timer: &self.thread_presentations.active().status_timer,
            interrupt_hint,
        })
    }

    pub(crate) fn active_turn(&self) -> Option<&TurnId> {
        self.thread.active_turn()
    }

    pub(crate) fn set_active_turn(&mut self, turn_id: TurnId) {
        self.thread_presentations
            .active_mut()
            .status_timer
            .bind_turn(&turn_id, Instant::now());
        self.thread.set_active_turn(turn_id);
    }

    pub(crate) fn set_active_turn_if_idle(&mut self, turn_id: TurnId) {
        if self.active_turn().is_none() {
            self.thread_presentations
                .active_mut()
                .status_timer
                .bind_turn(&turn_id, Instant::now());
        }
        self.thread.set_active_turn_if_idle(turn_id);
    }

    pub(crate) fn clear_active_turn(&mut self) {
        self.thread.clear_active_turn();
    }

    pub(crate) fn sync_active_turn(
        &mut self,
        turns: &[Turn],
    ) -> Vec<crate::thread::ActiveTurnUpdate> {
        let updates = self.thread.sync_active_turn(turns);
        if let Some(turn_id) = self.thread.active_turn() {
            self.thread_presentations
                .active_mut()
                .status_timer
                .bind_turn(turn_id, Instant::now());
        }
        updates
    }

    pub(crate) fn steers_active_turn(&self) -> bool {
        self.chat_panel.is_steering()
    }

    pub(crate) fn queue_view(&self) -> QueueView<'_> {
        self.thread_presentations
            .active()
            .queue
            .view(&self.viewport().queue)
    }

    pub(super) fn focus_queue_item(&mut self, id: QueueId) -> bool {
        let queue = &self.thread_presentations.active().queue;
        self.fullscreen
            .viewports
            .active_mut()
            .queue
            .focus(queue, id)
    }

    pub(crate) fn goal_view(&self) -> Option<&ash_protocol::ThreadGoal> {
        self.thread_presentations.active().goal.as_ref()
    }

    pub(crate) fn plan_view(&self) -> Option<crate::thread::plan::PlanInlineView<'_>> {
        self.thread_presentations.active().plan.view()
    }

    pub(crate) fn issue_manager(&self) -> Option<&crate::issues::Manager> {
        self.issues().is_open().then_some(self.issues())
    }

    pub(crate) fn finish_issue_start(
        &mut self,
        mode: crate::terminal::ScreenMode,
        generation: u64,
        result: Result<(), String>,
    ) {
        self.issues_in_mut(mode)
            .finish_start(generation, result.err());
    }

    pub(crate) fn session_manager_view(&self) -> Option<SessionManagerView<'_>> {
        (!self.fullscreen_home_visible()
            && self.session_navigation().preview.is_none()
            && matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Manager)
            ))
        .then(|| {
            self.session_navigation()
                .manager()
                .view(self.sessions.catalog())
        })
    }

    fn session_manager_focused_internal(&self) -> bool {
        matches!(
            self.session_navigation().screen(),
            Some(SessionScreen::Manager)
        ) && self.session_navigation().manager().focused()
    }

    #[cfg(test)]
    pub(crate) fn session_manager_focused(&self) -> bool {
        self.session_manager_focused_internal()
    }

    pub(crate) fn session_manager_hint(&self) -> &'static crate::widgets::key_hint::KeyHints {
        self.session_navigation().manager().status_hint()
    }

    pub(crate) fn session_preview(&self) -> Option<&ConversationPreview> {
        self.session_navigation().preview.as_ref()
    }

    pub(crate) fn finish_session_preview(
        &mut self,
        mode: crate::terminal::ScreenMode,
        generation: u64,
        result: Result<SessionThreadReadResult, String>,
    ) {
        self.session_navigation_in_mut(mode)
            .finish_preview(generation, result);
    }

    pub(crate) fn screen_navigation_tip(&self) -> Option<&'static str> {
        match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => {
                super::fullscreen::navigation::screen_navigation_tip(self)
            }
            crate::terminal::ScreenMode::Inline => {
                super::inline::navigation::screen_navigation_tip(self)
            }
        }
    }

    pub(crate) fn agent_thread_switcher_view(&self) -> Option<AgentThreadSwitcherView<'_>> {
        matches!(
            self.session_navigation().screen(),
            Some(SessionScreen::Session(_))
        )
        .then(|| self.agent_thread_switcher().view())
    }

    pub(crate) fn agent_thread_switcher_rows(&self) -> u16 {
        if matches!(
            self.session_navigation().screen(),
            Some(SessionScreen::Session(_))
        ) {
            self.agent_thread_switcher().desired_rows()
        } else {
            0
        }
    }

    pub(crate) fn agent_thread_switcher_focused(&self) -> bool {
        self.agent_thread_switcher().focused()
    }

    pub(crate) fn refresh_queued_messages(&self) -> Option<AppCommand> {
        Some(ThreadCommand::RefreshQueue.into())
    }

    pub(crate) fn approval_mode_status(&self) -> TurnApprovalModes {
        self.thread.approval_modes()
    }

    pub(crate) fn approval_mode(&self) -> ApprovalMode {
        self.thread.approval_mode()
    }

    pub(crate) fn cycle_next_approval_mode(&mut self, now: Instant) {
        self.thread.cycle_approval_mode();
        if self.screen_mode() == crate::terminal::ScreenMode::Fullscreen
            || self.thread.has_user_message()
        {
            self.chat_panel.show_policy_tip(now);
        }
    }

    #[cfg(test)]
    pub(crate) fn set_next_approval_mode(&mut self, approval_mode: ApprovalMode) {
        self.thread.set_next_approval_mode(approval_mode);
    }

    pub(crate) fn set_current_approval_mode(&mut self, approval_mode: Option<ApprovalMode>) {
        self.thread.set_current_approval_mode(approval_mode);
    }

    pub(crate) fn status_line(&self) -> &StatusLineModel {
        self.chat_panel.status_line()
    }

    pub(crate) fn request_status_line_git_text_diff(&mut self) -> bool {
        self.chat_panel
            .status_line_mut()
            .request_status_line_git_text_diff()
    }

    pub(crate) fn top_tip(&self) -> &TopTip {
        self.chat_panel.top_tip()
    }

    pub(crate) fn show_policy_tip(&mut self, now: Instant) {
        self.chat_panel.show_policy_tip(now);
    }

    pub(crate) fn status_line_runtime(&self) -> StatusLineRuntime {
        let plan = self.plan_view().map(|view| (view.completed, view.total));
        let visible_session = match self.session_navigation().screen() {
            Some(SessionScreen::Session(session_id)) => Some(session_id),
            Some(SessionScreen::Manager) | None => None,
        };
        let viewed_thread =
            visible_session.and_then(|session_id| self.sessions.remembered_thread(session_id));
        let subagents = visible_session
            .and_then(|session_id| {
                self.sessions
                    .catalog()
                    .iter()
                    .find(|session| &session.session_id == session_id)
            })
            .map(|session| {
                session
                    .threads
                    .iter()
                    .filter(|thread| {
                        thread.status == ash_protocol::ThreadStatus::Active
                            && thread.parent_thread_id.is_some()
                            && thread.forked_from_id.is_none()
                            && Some(&thread.thread_id) != viewed_thread
                    })
                    .count()
            })
            .unwrap_or(0);
        StatusLineRuntime {
            plan,
            subagents,
            process_resources: self.process_resources.view().local,
        }
    }

    pub(crate) fn apply_process_resource_request(&mut self, request: ProcessResourceRequest) {
        self.process_resources.apply_request(request);
        let resources = self.process_resources.view();
        self.panels_mut().apply_process_resources(resources);
    }

    pub(crate) fn accepts_input(&self) -> bool {
        (!self.starts_new_session() || self.sessions.pending_submission.is_none())
            && (self.fullscreen_home_visible()
                || (!self.issues().is_open()
                    && self.session_navigation().preview.is_none()
                    && !self.session_manager_focused_internal()
                    && self.approval_view().is_none()
                    && self.query_view().is_none()
                    && self.viewed_thread_accepts_input()
                    && matches!(
                        &self.status,
                        Status::Ready | Status::Working | Status::Error
                    )))
    }

    pub(crate) fn viewed_thread_completed(&self) -> bool {
        !self.starts_new_session()
            && !self.viewed_thread_accepts_input()
            && matches!(
                self.session_navigation().screen(),
                Some(SessionScreen::Session(_))
            )
    }

    fn viewed_thread_accepts_input(&self) -> bool {
        let Some(SessionScreen::Session(session_id)) = self.session_navigation().screen() else {
            return true;
        };
        let Some(thread_id) = self.sessions.remembered_thread(session_id) else {
            return true;
        };
        self.sessions
            .catalog()
            .iter()
            .find(|session| &session.session_id == session_id)
            .and_then(|session| {
                session
                    .threads
                    .iter()
                    .find(|thread| &thread.thread_id == thread_id)
            })
            .is_none_or(|thread| thread.status == ash_protocol::ThreadStatus::Active)
    }

    fn reconcile_queue_views(&mut self) {
        let queue = &self.thread_presentations.active().queue;
        self.fullscreen
            .viewports
            .active_mut()
            .queue
            .reconcile(queue);
        self.inline.viewports.active_mut().queue.reconcile(queue);
    }

    fn sync_preview_viewports(&mut self) {
        self.fullscreen.preview.bind(
            self.fullscreen
                .sessions
                .preview
                .as_ref()
                .map(|preview| preview.generation),
        );
        self.inline.preview.bind(
            self.inline
                .sessions
                .preview
                .as_ref()
                .map(|preview| preview.generation),
        );
    }

    pub(crate) fn update(&mut self, event: impl Into<AppEvent>) {
        let event = event.into();
        if !matches!(
            &event,
            AppEvent::Host(HostEvent::ProcessResourcesSampled(_))
        ) {
            self.fullscreen.pointer.clear();
        }
        match event {
            AppEvent::Issues(event) => self.issues_mut().update(event),
            AppEvent::Dirs(event) => self.apply_dir_event(event),
            AppEvent::Git(event) => match event {
                GitEvent::PickerOpened(choices) => {
                    self.open_command_panel(CommandPanel::git_branches(choices))
                }
                GitEvent::SwitchFinished(Ok(status)) => {
                    self.close_command_panel();
                    self.apply_status_event(StatusEvent::GitStatusReceived(status));
                }
                GitEvent::SwitchFinished(Err(error)) => {
                    self.panels_mut().set_command_message(error)
                }
            },
            AppEvent::Host(event) => self.apply_host_event(event),
            AppEvent::Config(event) => self.apply_config_event(event),
            AppEvent::Models(event) => self.apply_model_event(event),
            AppEvent::Projects(event) => match event {
                ProjectEvent::RootsOpened(choices) => {
                    self.open_command_panel(CommandPanel::project_roots(choices))
                }
                ProjectEvent::AddRootOpened(choices) => {
                    self.open_command_panel(CommandPanel::project_dirs(choices))
                }
                ProjectEvent::AddRootFinished { request_id, result } => {
                    self.panels_mut().finish_dir_add(request_id, result)
                }
            },
            AppEvent::Thread(event) => self.apply_thread_event(event),
            AppEvent::Keymap(event) => self.apply_keymap_event(event),
            AppEvent::Status(event) => self.apply_status_event(event),
            AppEvent::Usage(crate::usage::Event::Opened(model)) => {
                self.open_command_panel(CommandPanel::usage(model));
            }
            AppEvent::Connectors(event) => self.apply_connector_event(event),
            AppEvent::Memories(event) => match event {
                crate::memories::Event::Changed(changed) => {
                    if let Some(CommandPanel::Memories(panel)) = self.panels_mut().command_mut() {
                        panel.changed(changed);
                    }
                }
                crate::memories::Event::Config(event) => self.update(event),
                crate::memories::Event::Finished { command, result } => {
                    if let Some(CommandPanel::Memories(panel)) = self.panels_mut().command_mut() {
                        panel.finish(command, result);
                    } else {
                        match result {
                            Ok(page) => self.open_command_panel(CommandPanel::memories(page)),
                            Err(error) => self.open_command_panel(CommandPanel::loading(
                                "Memories",
                                &error.message,
                            )),
                        }
                    }
                }
            },
            AppEvent::Marketplace(event) => {
                let selected = match (&event.0, self.command_panel()) {
                    (
                        crate::marketplace::Page::Installed { selected: None, .. },
                        Some(CommandPanel::Marketplace(panel)),
                    ) if panel.installed() => panel
                        .state()
                        .selected_item()
                        .and_then(|item| item.id())
                        .cloned(),
                    _ => None,
                };
                let tabs_focused = matches!(self.command_panel(), Some(CommandPanel::Marketplace(panel)) if panel.state().tabs_focused());
                let mut panel = crate::marketplace::Panel::new(event.0);
                if let Some(selected) = selected {
                    panel.state_mut().focus_item(&selected);
                }
                if tabs_focused {
                    let tab = panel.state().active_tab_index();
                    panel.state_mut().focus_pointer(
                        &crate::widgets::list_selection::ListSelectionPointerTarget::Tab(tab),
                    );
                }
                self.open_command_panel(CommandPanel::Marketplace(panel));
            }
            AppEvent::Lsp(event) => {
                self.open_command_panel(CommandPanel::Lsp(crate::lsp::Panel::new(event.0)))
            }
            AppEvent::Mcp(event) => self.apply_mcp_event(event),
            AppEvent::Sessions(event) => self.apply_session_event(event),
            AppEvent::CommandPanelClosed => self.close_command_panel(),
            #[cfg(test)]
            AppEvent::HelpOpened(model) => self.show_help(model),
            AppEvent::Skills(event) => self.apply_skill_event(event),
            AppEvent::Theme(event) => self.apply_theme_event(event),
        }
        self.reconcile_queue_views();
        self.sync_preview_viewports();
    }

    pub(super) fn presentation_mode(
        &self,
        origin: super::requests::RequestOrigin,
    ) -> crate::terminal::ScreenMode {
        if origin.panel_generation != 0 && self.panels().generation() == origin.panel_generation {
            self.screen_mode()
        } else {
            origin.mode
        }
    }

    pub(crate) fn startup_context(&self) -> &TuiStartupContext {
        &self.startup_context
    }

    pub(super) fn update_from_origin(
        &mut self,
        origin: super::requests::RequestOrigin,
        event: impl Into<AppEvent>,
    ) {
        match event.into() {
            AppEvent::Issues(event) => self.issues_in_mut(origin.mode).update(event),
            AppEvent::Sessions(SessionEvent::DetailsReceived { generation, result }) => {
                self.session_navigation_in_mut(origin.mode)
                    .finish_details(generation, result);
            }
            event => self.update_for_panel(origin.panel_generation, event),
        }
        self.reconcile_queue_views();
        self.sync_preview_viewports();
    }

    /// Background results may update shared facts after dismissal, but not a newer editor.
    pub(super) fn update_for_panel(&mut self, generation: u64, event: impl Into<AppEvent>) {
        let event = event.into();
        if generation == self.panels().generation() {
            if let AppEvent::Thread(
                ThreadEvent::FailureReported(error) | ThreadEvent::CommandFailed { error, .. },
            ) = &event
                && let Some(CommandPanel::Loading(_)) = self.command_panel()
            {
                let title = self
                    .command_panel()
                    .unwrap()
                    .body()
                    .title(self.language())
                    .into_owned();
                self.open_command_panel(CommandPanel::loading(&title, error));
            }
            if let AppEvent::Thread(
                ThreadEvent::FailureReported(error) | ThreadEvent::CommandFailed { error, .. },
            ) = &event
            {
                match self.panels_mut().command_mut() {
                    Some(CommandPanel::Marketplace(panel)) => panel.fail(error.clone()),
                    Some(CommandPanel::Lsp(panel)) => panel.fail(error.clone()),
                    _ => {}
                }
            }
            self.update(event);
            return;
        }
        match event {
            AppEvent::Config(ConfigEvent::Updated(result)) => {
                self.update(ConfigEvent::SettingsReceived(result.terminal));
                self.update(StatusEvent::LineSettingsReceived(result.status_line));
            }
            AppEvent::Keymap(KeymapEvent::EditorOpened(result)) => {
                self.update(KeymapEvent::SettingsReceived(result.settings))
            }
            AppEvent::Status(
                StatusEvent::LineEditorOpened(result) | StatusEvent::LineEditorUpdated(result),
            ) => {
                self.update(StatusEvent::LineSettingsReceived(result.settings));
            }
            AppEvent::Skills(
                SkillEvent::SettingsOpened(choices) | SkillEvent::SettingsUpdated(choices),
            ) => {
                self.update(SkillEvent::DiagnosticsReceived(choices.diagnostics));
            }
            AppEvent::Config(
                ConfigEvent::EditorOpened(_)
                | ConfigEvent::AdvisorOpened(_)
                | ConfigEvent::ApiKeySaved { .. }
                | ConfigEvent::Connection(_),
            )
            | AppEvent::Models(ModelEvent::PickerOpened(_) | ModelEvent::PickerUpdated(_))
            | AppEvent::Status(StatusEvent::PanelOpened(_))
            | AppEvent::Usage(_)
            | AppEvent::Sessions(SessionEvent::PickerOpened(_))
            | AppEvent::Connectors(
                ConnectorEvent::PickerOpened(_) | ConnectorEvent::PickerUpdated(_),
            )
            | AppEvent::Marketplace(_)
            | AppEvent::Lsp(_)
            | AppEvent::Memories(_)
            | AppEvent::Mcp(McpEvent::SettingsOpened(_) | McpEvent::SettingsUpdated(_))
            | AppEvent::Theme(ThemeEvent::PickerOpened(_))
            | AppEvent::Thread(ThreadEvent::RewindPickerOpened(_))
            | AppEvent::CommandPanelClosed => {}
            event => self.update(event),
        }
    }

    fn apply_thread_event(&mut self, event: ThreadEvent) {
        match event {
            ThreadEvent::CommandFailed { command, error } => {
                self.thread
                    .update(ThreadPresentationEvent::CommandFailed { command, error });
            }
            ThreadEvent::CommandStarted(command) => {
                self.thread
                    .update(ThreadPresentationEvent::CommandStarted(command));
            }
            ThreadEvent::CommandCompleted { command, result } => {
                self.thread
                    .update(ThreadPresentationEvent::CommandCompleted { command, result });
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
            ThreadEvent::FailureReported(error) => {
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(error));
                self.set_status(Status::Error);
                self.chat_panel.start_input();
            }
            ThreadEvent::ProductNotice(notice) => {
                self.thread
                    .update(ThreadPresentationEvent::NoticeReceived(notice));
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
            ThreadEvent::FileSearchSnapshotReceived(snapshot) => {
                let (_, input) = self.composer_parts_mut();
                input.apply_file_search_snapshot(snapshot);
            }
            ThreadEvent::InterruptFailed(error) => {
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(format!(
                        "could not interrupt turn: {error}"
                    )));
                self.set_status(Status::Working);
                self.chat_panel.steer_input();
            }
            ThreadEvent::ApprovalRequested(approval) => self.chat_panel.show_approval(approval),
            ThreadEvent::QueryRequested(query) => self.chat_panel.show_query(query),
            ThreadEvent::RewindPickerOpened(view) => self.show_rewind_picker(view),
            ThreadEvent::RequestResolved(request) => self.close_thread_request(&request),
            ThreadEvent::RequestSubmissionFailed { request, error } => {
                self.fail_thread_request(&request, error);
            }
            ThreadEvent::ContextChanged {
                session_id,
                thread_id,
            } => {
                let context_changed = self.sessions.active_session_id() != Some(&session_id)
                    || self.sessions.remembered_thread(&session_id) != Some(&thread_id);
                if context_changed {
                    self.sessions.pending_submission = None;
                    self.sessions.creation_error = None;
                    self.thread
                        .switch_transcript(self.thread_presentations.active_id(), &thread_id);
                    self.thread_presentations.switch(thread_id.clone());
                    self.fullscreen.viewports.switch(thread_id.clone());
                    self.inline.viewports.switch(thread_id.clone());
                    self.sessions.activate_context(session_id, thread_id);
                    self.sync_session_views();
                    self.chat_panel.status_line_mut().clear_thread_accounting();
                    self.chat_panel.reset_top_tip();
                }
                self.reconcile_agent_thread_switcher();
            }
            ThreadEvent::AccountingChanged {
                usage,
                reference_cost,
            } => self
                .chat_panel
                .status_line_mut()
                .apply_thread_accounting(&usage, &reference_cost),
            ThreadEvent::ContextUsageChanged(usage) => {
                self.chat_panel.status_line_mut().apply_context_usage(usage)
            }
            ThreadEvent::GoalChanged(goal) => {
                self.thread_presentations.active_mut().goal = goal;
            }
            ThreadEvent::SteerCompleted { steer_id, .. } => {
                self.chat_panel.finish_steer(steer_id);
            }
            ThreadEvent::SteerSubmissionFailed {
                steer_id, error, ..
            } => {
                self.chat_panel.finish_steer(steer_id);
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(format!(
                        "could not steer the active Turn: {error}"
                    )));
            }
            ThreadEvent::QueueReceived { messages, restore } => {
                let state = self.thread_presentations.active_mut();
                let result = state.queue.apply(messages).and_then(|()| match restore {
                    Some(id) => state.queue.restore(id, &mut state.input),
                    None => Ok(()),
                });
                if let Err(error) = result {
                    self.thread
                        .update(ThreadPresentationEvent::FailureReported(error));
                }
            }
            ThreadEvent::QueueFailed { queue_id, error } => {
                if let Some(id) = queue_id {
                    self.thread_presentations.active_mut().queue.fail_send(id);
                }
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(format!(
                        "could not update the queue: {error}"
                    )));
            }
            ThreadEvent::TranscriptSnapshotReceived(transcript) => {
                self.thread
                    .update(ThreadPresentationEvent::TranscriptSnapshotReceived(
                        transcript,
                    ));
                self.reconcile_transcript_scroll_anchor();
                self.hide_navigation_for_existing_conversation();
            }
            ThreadEvent::TranscriptHistoryPageReceived(transcript) => {
                let reveal_older_history = self.transcript_scroll_is_at_first_cell();
                self.thread
                    .update(ThreadPresentationEvent::TranscriptHistoryPageReceived(
                        transcript,
                    ));
                if reveal_older_history {
                    let messages = self.visible_transcript_views();
                    if let Some(target) = first_scroll_target(true, &messages) {
                        self.viewport_mut().scroll.apply(target);
                    }
                } else {
                    self.reconcile_transcript_scroll_anchor();
                }
                self.hide_navigation_for_existing_conversation();
            }
            ThreadEvent::TranscriptUpdateReceived(update) => {
                self.thread
                    .update(ThreadPresentationEvent::TranscriptUpdateReceived(update));
                self.reconcile_transcript_scroll_anchor();
                self.hide_navigation_for_existing_conversation();
            }
            ThreadEvent::TranscriptCleared => {
                self.thread.update(ThreadPresentationEvent::Cleared);
                self.reconcile_transcript_scroll_anchor();
                self.chat_panel.reset_top_tip();
                self.skill_diagnostic_warnings.clear();
                self.fullscreen
                    .viewports
                    .active_mut()
                    .scroll
                    .follow_latest();
                self.inline.viewports.active_mut().scroll.follow_latest();
                self.chat_panel.clear_steers();
                self.thread_presentations.active_mut().queue.clear();
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
            ThreadEvent::TurnActivityChanged(activity) => {
                self.set_status(match activity {
                    TurnActivity::Starting | TurnActivity::Working => Status::Working,
                    TurnActivity::WaitingForApproval => Status::WaitingForApproval,
                    TurnActivity::WaitingForUserInput => Status::WaitingForUserInput,
                    TurnActivity::WaitingForCapability => Status::WaitingForCapability,
                    TurnActivity::Cancelling => Status::Cancelling,
                });
                self.chat_panel.apply_turn_activity(activity);
            }
            ThreadEvent::TurnPlanChanged(plan) => {
                self.thread_presentations.active_mut().plan.replace(plan);
            }
            ThreadEvent::PendingInteractionChanged(pending) => {
                self.chat_panel.reconcile_request(pending.as_ref());
            }
            ThreadEvent::TurnFailed => {
                self.thread.finish_stream();
                self.set_status(Status::Error);
                self.chat_panel.start_input();
                self.chat_panel.clear_steers();
                self.thread_presentations.active_mut().plan.replace(None);
            }
            ThreadEvent::TurnCompleted => {
                self.thread.finish_stream();
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
                self.chat_panel.clear_steers();
                self.thread_presentations.active_mut().plan.replace(None);
            }
            ThreadEvent::TurnInterrupted => {
                self.thread.update(ThreadPresentationEvent::Interrupted);
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
                self.chat_panel.clear_steers();
                self.thread_presentations.active_mut().plan.replace(None);
            }
        }
    }

    fn apply_dir_event(&mut self, event: DirEvent) {
        match event {
            DirEvent::PickerOpened(view) => self.show_dirs_picker(view),
            DirEvent::AddCompleted { request_id, result } => {
                self.panels_mut().finish_dir_add(request_id, result);
            }
            DirEvent::Removed { path, choices } => {
                self.update_dirs_picker(choices);
                self.thread
                    .update(ThreadPresentationEvent::NoticeReceived(format!(
                        "Removed directory {}",
                        path.display()
                    )));
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
            DirEvent::PermissionsUpdated(choices) => self.update_dirs_picker(choices),
            DirEvent::Moved { path } => {
                self.welcome = WelcomeModel::for_workspace(&path);
                self.startup_context.workspace = path.clone();
                self.thread
                    .update(ThreadPresentationEvent::NoticeReceived(format!(
                        "Moved session to {}",
                        path.display()
                    )));
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
        }
    }

    fn apply_host_event(&mut self, event: HostEvent) {
        match event {
            HostEvent::ClipboardImageRead { target, result } => {
                self.attach_clipboard_image(target, result)
            }
            HostEvent::ClipboardImageAvailabilityChanged(availability) => match availability {
                ClipboardImageAvailability::Available(fingerprint) => {
                    self.chat_panel
                        .show_clipboard_image(fingerprint, Instant::now());
                }
                ClipboardImageAvailability::Unavailable => self.chat_panel.hide_clipboard_image(),
            },
            HostEvent::OperationCompleted(Ok(notice)) => {
                self.thread
                    .update(ThreadPresentationEvent::NoticeReceived(notice));
            }
            HostEvent::OperationCompleted(Err(error)) => {
                self.thread
                    .update(ThreadPresentationEvent::FailureReported(error));
            }
            HostEvent::ProcessResourcesSampled(reading) => {
                self.process_resources.apply(reading);
                let resources = self.process_resources.view();
                self.panels_mut().apply_process_resources(resources);
            }
            HostEvent::TopTipNoticeShown(notice) => {
                self.chat_panel.show_notice(notice, Instant::now());
            }
        }
    }

    fn apply_config_event(&mut self, event: ConfigEvent) {
        self.fullscreen.pointer.cancel_click();
        match event {
            ConfigEvent::AdvisorOpened(choices) => {
                self.panels_mut().open_advisor(choices);
            }
            ConfigEvent::Connection(reply) => {
                if let Err(error) = &reply.result {
                    self.thread
                        .update(ThreadPresentationEvent::NoticeReceived(format!(
                            "Provider update failed: {error}"
                        )));
                }
                self.panels_mut().complete_connection(reply);
                self.set_status(Status::Ready);
            }
            ConfigEvent::Subscription(event) => {
                for subscription in &mut self.subscriptions {
                    subscription.update(event.clone());
                }
                let mut choices = self.subscriptions[self.selected_subscription.index()].choices();
                self.localize_selection(&mut choices);
                self.panels_mut().update_subscription(choices);
            }
            ConfigEvent::SubscriptionReply(provider, event) => {
                self.subscriptions[provider.index()].update(event);
                if provider == self.selected_subscription {
                    let mut choices = self.subscriptions[provider.index()].choices();
                    self.localize_selection(&mut choices);
                    self.panels_mut().update_subscription(choices);
                }
            }
            ConfigEvent::SettingsReceived(settings) => {
                self.set_terminal_settings(settings);
                if !self.mouse_mode().captures_terminal_input() {
                    self.fullscreen.clear();
                }
                self.sessions.input.set_input_mode(settings.input_mode());
                self.thread_presentations
                    .set_input_mode(settings.input_mode());
            }
            ConfigEvent::Updated(result) => {
                self.set_terminal_settings(result.terminal);
                self.chat_panel
                    .status_line_mut()
                    .apply_settings(result.status_line);
                if !self.mouse_mode().captures_terminal_input() {
                    self.fullscreen.clear();
                }
                self.sessions
                    .input
                    .set_input_mode(result.terminal.input_mode());
                self.thread_presentations
                    .set_input_mode(result.terminal.input_mode());
                self.panels_mut().replace_config(result.choices);
            }
            ConfigEvent::EditorOpened(view) => {
                self.open_command_panel(CommandPanel::config(view));
            }
            ConfigEvent::ApiKeySaved { provider, choices } => {
                self.panels_mut().finish_config_prompt(choices);
                self.thread
                    .update(ThreadPresentationEvent::NoticeReceived(format!(
                        "Saved API key for {provider}"
                    )));
                self.set_status(Status::Ready);
                self.chat_panel.start_input();
            }
        }
    }

    fn apply_model_event(&mut self, event: ModelEvent) {
        match event {
            ModelEvent::SummaryReceived(summary) => {
                let model_label = summary.model_and_effort_label();
                self.chat_panel
                    .status_line_mut()
                    .apply_model_label(model_label);
                self.chat_panel
                    .status_line_mut()
                    .apply_context_capacity(summary.model(), summary.context_capacity());
                self.welcome.apply_model_summary(&summary);
            }
            ModelEvent::PickerOpened(view) => self.show_model_picker(view),
            ModelEvent::PickerUpdated(mut view) => {
                self.localize_selection(&mut view);
                self.panels_mut().replace_model(view);
            }
        }
    }

    fn apply_keymap_event(&mut self, event: KeymapEvent) {
        match event {
            KeymapEvent::SettingsReceived(settings) => {
                self.app_keymap = settings.keymap;
                for diagnostic in settings.diagnostics {
                    self.report_keybinding_diagnostic(diagnostic);
                }
            }
            KeymapEvent::EditorOpened(update) => {
                self.app_keymap = update.settings.keymap;
                for diagnostic in update.settings.diagnostics {
                    self.report_keybinding_diagnostic(diagnostic);
                }
                if let Some(notice) = update.notice {
                    self.thread
                        .update(ThreadPresentationEvent::NoticeReceived(notice));
                }
                if self.panels().command_is_keymap() {
                    let mut choices = update.choices;
                    self.localize_selection(&mut choices);
                    self.panels_mut().replace_keymap(choices);
                } else {
                    self.show_keymap_editor(update.choices);
                }
            }
        }
    }

    fn apply_status_event(&mut self, event: StatusEvent) {
        match event {
            StatusEvent::LineSettingsReceived(settings) => {
                self.chat_panel.status_line_mut().apply_settings(settings);
            }
            StatusEvent::LineEditorOpened(update) => {
                self.chat_panel
                    .status_line_mut()
                    .apply_settings(update.settings);
                self.show_status_line_editor(update.choices);
            }
            StatusEvent::LineEditorUpdated(update) => {
                self.chat_panel
                    .status_line_mut()
                    .apply_settings(update.settings);
                self.update_status_line_editor(update.choices);
            }
            StatusEvent::PanelOpened(panel) => self.show_status_panel(panel),
            StatusEvent::MemoryDiagnosticsChanged(status) => {
                self.memory_diagnostics = status;
            }
            StatusEvent::GitStatusReceived(status) => {
                self.chat_panel.status_line_mut().apply_git_status(&status);
            }
            StatusEvent::GitTextDiffReceived { status, statistics } => self
                .chat_panel
                .status_line_mut()
                .apply_git_text_diff(status, statistics),
        }
    }

    fn apply_connector_event(&mut self, event: ConnectorEvent) {
        match event {
            ConnectorEvent::PickerOpened(view) => self.show_connector_picker(view),
            ConnectorEvent::PickerUpdated(view) => self.update_connector_picker(view),
        }
    }

    fn apply_mcp_event(&mut self, event: McpEvent) {
        match event {
            McpEvent::SettingsOpened(view) => self.show_mcp_settings(view),
            McpEvent::SettingsUpdated(view) => self.update_mcp_settings(view),
        }
    }

    fn apply_session_event(&mut self, event: SessionEvent) {
        match event {
            SessionEvent::DetailsReceived { generation, result } => self
                .session_navigation_mut()
                .finish_details(generation, result),
            SessionEvent::PickerOpened(view) => self.show_session_picker(view),
            SessionEvent::CatalogReceived(catalog) => {
                self.sessions.refresh_catalog(catalog);
                self.fullscreen.sessions.reconcile(&self.sessions);
                self.inline.sessions.reconcile(&self.sessions);
                self.reconcile_agent_thread_switcher();
            }
        }
    }

    fn apply_skill_event(&mut self, event: SkillEvent) {
        match event {
            SkillEvent::SettingsOpened(view) => self.show_skill_settings(view),
            SkillEvent::SettingsUpdated(view) => self.update_skill_settings(view),
            SkillEvent::DiagnosticsReceived(diagnostics) => {
                self.report_skill_diagnostics(&diagnostics);
            }
        }
    }

    fn apply_theme_event(&mut self, event: ThemeEvent) {
        match event {
            ThemeEvent::PickerOpened(view) => {
                if self.panels().command_is_theme() {
                    self.panels_mut().push_custom_theme(view);
                } else {
                    self.show_theme_picker(view);
                }
            }
            ThemeEvent::RenderChanged(theme) => {
                self.render_theme = theme;
                self.render_theme_revision = self.render_theme_revision.wrapping_add(1).max(1);
            }
        }
    }

    pub(super) fn app_keymap_context(&self, is_press: bool) -> AppKeymapContext {
        AppKeymapContext {
            accepts_input: self.accepts_input(),
            has_selection: self.list_selection().is_some(),
            chat_input_empty: self.input().is_empty(),
            is_press,
        }
    }

    fn reconcile_agent_thread_switcher(&mut self) {
        let session_id = self.sessions.active_session_id();
        let thread = session_id.and_then(|id| self.sessions.remembered_thread(id));
        let session = session_id.and_then(|id| {
            self.sessions
                .catalog()
                .iter()
                .find(|session| &session.session_id == id)
        });
        self.fullscreen
            .agent_thread_switcher
            .reconcile(session, thread);
        self.inline.agent_thread_switcher.reconcile(session, thread);
    }

    fn transcript_scroll_is_at_first_cell(&self) -> bool {
        let Some(TranscriptScrollAnchor::Cell {
            cell_id,
            line_offset,
        }) = self.transcript_scroll().anchor()
        else {
            return false;
        };
        *line_offset == 0
            && self
                .thread
                .cells()
                .first()
                .is_some_and(|cell| cell.cell_id().as_str() == cell_id.as_str())
    }

    fn reconcile_transcript_scroll_anchor(&mut self) {
        let cells = self
            .thread
            .cells()
            .iter()
            .map(|cell| cell.cell_id().clone())
            .collect();
        self.fullscreen.viewports.active_mut().reconcile(&cells);
        self.inline.viewports.active_mut().reconcile(&cells);
    }

    pub(super) fn apply_app_keymap_action(
        &mut self,
        action: AppKeymapAction,
        now: Instant,
    ) -> Option<AppCommand> {
        match action {
            AppKeymapAction::CycleApprovalMode => Some(ThreadCommand::CycleNextApprovalMode.into()),
            AppKeymapAction::ScreenEscape => match self.escape_mut().press(now) {
                ScreenEscapeOutcome::WaitingForSecondPress => None,
                ScreenEscapeOutcome::OpenRewind => Some(ThreadCommand::OpenRewindPicker.into()),
            },
            AppKeymapAction::OpenRewind => Some(ThreadCommand::OpenRewindPicker.into()),
            AppKeymapAction::ReadClipboardImage => Some(
                HostCommand::ReadClipboardImage {
                    target: self.draft_target(),
                }
                .into(),
            ),
            AppKeymapAction::InterruptOrQuit => self.quit_or_interrupt(),
            AppKeymapAction::CopyLastResponse => Some(HostCommand::CopyLastResponse.into()),
            AppKeymapAction::Suspend => Some(AppCommand::Suspend),
        }
    }

    pub(crate) fn poll_issue_refresh(&mut self, now: Instant) -> Option<AppCommand> {
        self.issues_mut().poll_refresh(now).map(Into::into)
    }

    pub(crate) fn handle_tick(&mut self, now: Instant) -> bool {
        let context = self.app_keymap_context(true);
        let chord_expired = self.app_keymap.expire(context, now);
        let status_changed = self
            .thread_presentations
            .active_mut()
            .status_timer
            .tick(now);
        let top_tip_changed = self.chat_panel.poll_top_tip(now, self.screen_mode());
        let elapsed_changed = self.agent_thread_switcher_mut().refresh_elapsed();
        let manager_changed = matches!(
            self.session_navigation().screen(),
            Some(SessionScreen::Manager)
        ) && match self.screen_mode() {
            crate::terminal::ScreenMode::Fullscreen => self
                .fullscreen
                .sessions
                .refresh_manager_time(&self.sessions, now),
            crate::terminal::ScreenMode::Inline => self
                .inline
                .sessions
                .refresh_manager_time(&self.sessions, now),
        };
        chord_expired
            || status_changed
            || top_tip_changed
            || elapsed_changed
            || manager_changed
            || self.command_panel().is_some_and(CommandPanel::is_testing)
    }

    fn hide_navigation_for_existing_conversation(&mut self) {
        if self.thread.has_user_message() {
            self.chat_panel.hide_navigation();
        }
    }

    pub(crate) fn pending_key_chord_label(&self) -> Option<String> {
        self.app_keymap.pending_chord_label()
    }

    pub(crate) fn report_keybinding_diagnostic(&mut self, diagnostic: impl Into<String>) {
        self.thread
            .update(ThreadPresentationEvent::FailureReported(format!(
                "Keybindings: {}",
                diagnostic.into()
            )));
    }

    fn handle_slash_command(&mut self, invocation: SlashCommandInvocation) -> Option<AppCommand> {
        let local = invocation
            .command
            .name
            .parse::<TuiSlashCommandAction>()
            .ok();
        if invocation.origin == SlashCommandOrigin::Local
            && let Some(action) = local
            && action != TuiSlashCommandAction::Quit
        {
            self.thread
                .update(ThreadPresentationEvent::CommandSubmitted {
                    command: invocation.display_text(),
                    completion: action.completion(&invocation.arguments),
                });
        }
        if invocation.origin == SlashCommandOrigin::Local && invocation.arguments.is_empty() {
            match local {
                Some(TuiSlashCommandAction::Home) => {
                    self.open_home();
                    return None;
                }
                Some(TuiSlashCommandAction::Pr) => {
                    self.sessions.active_session_id()?;
                    self.close_transient_surfaces();
                    let text = "Prepare and create a pull request for the current changes using the connected GitHub tools. Verify the target branch and checks, and report the pull request link.".to_owned();
                    let submission = crate::thread::composer::ChatSubmission {
                        display_text: text.clone(),
                        input: vec![crate::thread::composer::ChatInputItem::Text(text)],
                    };
                    return self.handle_chat_composer_outcome(
                        ChatComposerOutcome::Submit(submission),
                        Instant::now(),
                    );
                }
                Some(TuiSlashCommandAction::Issue) => return self.open_issues(),
                Some(TuiSlashCommandAction::Dashboard) => {
                    self.show_session_manager();
                    return None;
                }
                Some(TuiSlashCommandAction::Subagents) => {
                    self.agent_thread_switcher_mut().focus();
                    return None;
                }
                _ => {}
            }
        }
        if matches!(local, Some(TuiSlashCommandAction::Export))
            && invocation
                .arguments
                .iter()
                .any(|argument| matches!(argument, ChatInputItem::Image { .. }))
        {
            self.thread.update(ThreadPresentationEvent::FailureReported(
                "/export accepts a relative text path, not image arguments".into(),
            ));
            return None;
        }
        if matches!(self.status, Status::Working)
            && !self.fullscreen_home_visible()
            && invocation.origin == SlashCommandOrigin::Local
            && !matches!(local, Some(TuiSlashCommandAction::Export))
        {
            self.thread.update(ThreadPresentationEvent::CommandFailed {
                command: invocation.display_text(),
                error: format!("/{} is unavailable while a turn is running; submit a follow-up prompt or wait for the turn to finish", invocation.command.name),
            });
            return None;
        }
        match (invocation.origin, local) {
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Quit))
                if invocation.arguments.is_empty() =>
            {
                Some(AppCommand::Quit)
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Fork)) => {
                match invocation.text_arguments() {
                    Ok(prompt) => Some(SessionCommand::Fork { prompt }.into()),
                    Err(error) => {
                        self.thread.update(ThreadPresentationEvent::CommandFailed {
                            command: invocation.display_text(),
                            error,
                        });
                        None
                    }
                }
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Export)) => {
                let requested_path = (!invocation.display_arguments.trim().is_empty())
                    .then(|| PathBuf::from(invocation.display_arguments.trim()));
                Some(HostCommand::ExportTranscript { requested_path }.into())
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Shortcuts))
                if invocation.arguments.is_empty() =>
            {
                Some(KeymapCommand::OpenEditor.into())
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Config))
                if invocation.arguments.is_empty() =>
            {
                Some(ConfigCommand::OpenEditor.into())
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Startup))
                if invocation.arguments.is_empty() =>
            {
                self.show_startup_panel();
                None
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::StatusLine))
                if invocation.arguments.is_empty() =>
            {
                Some(StatusCommand::OpenLineEditor.into())
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Theme))
                if invocation.arguments.is_empty() =>
            {
                Some(ThemeCommand::OpenPicker.into())
            }
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Theme)) => Some(
                ThemeCommand::Set {
                    preference: invocation.display_arguments.trim().to_owned(),
                }
                .into(),
            ),
            (SlashCommandOrigin::Local, Some(TuiSlashCommandAction::Help)) => {
                let spec = help_choices(
                    self.thread_presentations.slash_commands(),
                    self.app_keymap.setup_actions(),
                );
                self.open_command_panel(CommandPanel::help(spec));
                None
            }
            (SlashCommandOrigin::Server, _)
                if invocation.command.name == "advisor"
                    && invocation.display_arguments.trim().is_empty() =>
            {
                self.insert_text("/advisor ");
                None
            }
            (SlashCommandOrigin::Server, _)
                if invocation.command.name == "advisor" && self.chat_panel.is_steering() =>
            {
                self.thread.update(ThreadPresentationEvent::NoticeReceived(
                    "Wait for the active Turn before consulting the advisor".into(),
                ));
                None
            }
            (SlashCommandOrigin::Server, _) => {
                let submission = invocation.into_forwarded_submission();
                self.thread.update(ThreadPresentationEvent::UserSubmitted(
                    submission.display_text.clone(),
                ));
                if self.chat_panel.is_steering() {
                    let steer_id = self.chat_panel.begin_steer(submission.display_text.clone());
                    return Some(
                        ThreadCommand::SteerTurn {
                            steer_id,
                            submission,
                        }
                        .into(),
                    );
                }
                self.set_status(Status::Working);
                self.chat_panel.queue_input();
                Some(ThreadCommand::SubmitTurn { submission }.into())
            }
            (SlashCommandOrigin::Local, Some(_)) => {
                Some(ThreadCommand::ExecuteProductCommand(invocation).into())
            }
            (SlashCommandOrigin::Local, None) => None,
        }
    }

    fn quit_or_interrupt(&mut self) -> Option<AppCommand> {
        match &self.status {
            Status::Working
            | Status::WaitingForApproval
            | Status::WaitingForUserInput
            | Status::WaitingForCapability => {
                self.set_status(Status::Cancelling);
                Some(ThreadCommand::Interrupt.into())
            }
            Status::Cancelling => None,
            Status::Ready | Status::Error => Some(AppCommand::Quit),
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
use crate::thread::composer::CompletionView;
#[cfg(test)]
use crate::thread::composer::SlashCommandCatalog;
use crate::thread::composer::SlashCommandInvocation;
use crate::thread::composer::TuiSlashCommandAction;
use ash_slash_commands::SlashCommandOrigin;
