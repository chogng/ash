use super::*;
use crate::QuickAccess;

pub(crate) struct WorkbenchApplication {
    pub(super) window: Option<WindowHandle>,
    pub(super) memory: crate::memory::MemoryUi,
    pub(super) memories: crate::memories::MemoriesUi,
    pub(super) presentation: Option<WorkbenchPresentation>,
    pub(super) frame_scheduler: FrameScheduler,
    pub(super) retained_runtime: RetainedRuntime,
    pub(super) files: FilesState,
    pub(super) scm: ScmState,
    pub(super) files_pane_expanded: bool,
    pub(super) file_editor_host: FileEditorHost,
    pub(super) file_editor_input: FileEditorInputState,
    pub(super) file_editor_search: FileEditorSearchState,
    pub(super) language_service: FileEditorLanguageService,
    pub(super) session_search: SessionSearchState,
    pub(super) workbench: WorkbenchHost<PaneBinding>,
    pub(super) terminal_runtime: TerminalRuntime,
    pub(super) terminal_pane_views: TerminalPaneViews<PaneKey, TerminalPaneViewState>,
    pub(super) git_branch_picker: GitBranchPickerState,
    pub(super) directory_picker: DirectoryPickerState,
    pub(super) remote_connection_picker: RemoteConnectionPickerState,
    pub(super) remote_connection_manager: RemoteConnectionManagerState,
    pub(super) remote_connection_launch: Option<remote_connection_process::RemoteConnectionLaunch>,
    pub(super) remote_tunnel_manager: RemoteTunnelManagerState,
    pub(super) remote_tunnel_host: Option<RemoteTunnelHost>,
    pub(super) ui_dispatch: UiDispatch,
    pub(super) session_runtime: Option<SessionRuntime>,
    pub(super) app_server_client: Option<AppServerRequestHandle>,
    pub(super) app_server_host: AppServerHost,
    pub(super) session_pane: SessionPaneState,
    pub(super) classification_task: Option<zui::runtime::Task>,
    pub(super) main_surface: MainSurface,
    pub(super) env: EnvironmentContext,
    pub(super) text_layout: TextInputLayoutEngine,
    pub(super) caret_blink: CaretBlinkController,
    pub(super) code_editor_style: CodeEditorStyle,
    pub(super) gui: GuiConfig,
    pub(super) event_proxy: zui::app::AppProxy<WorkbenchEvent>,
    pub(super) clipboard: ClipboardHandle,
    pub(super) cursor_position: Option<Point>,
    pub(super) keybindings: keybindings::WorkbenchKeybindings,
    pub(super) keybinding_diagnostics: Vec<String>,
    pub(super) quick_access: QuickAccess,
    pub(super) settings: SettingsState,
    pub(super) modifiers: ModifiersState,
    pub(super) pending_focus: Option<ElementId>,
    pub(super) physical_extent: PhysicalExtent,
    pub(super) scale_factor: f64,
    pub(super) failed: bool,
    pub(super) palette: UiTheme,
    pub(super) typography: UiTypography,
    pub(super) theme_scheme: ColorScheme,
    pub(super) system_theme_scheme: ColorScheme,
    pub(super) theme_follows_system: bool,
}

impl WorkbenchApplication {
    pub(super) fn new(application: ApplicationHandle<WorkbenchEvent>, launch: AppLaunch) -> Self {
        let event_proxy = application.proxy();
        let clipboard = application.clipboard();
        let local_env = EnvironmentContext::capture_current();
        let app_server_host = launch.app_server_host(local_env.working_directory());
        let remote_tunnel_host = app_server_host
            .ssh_transport()
            .map(|(host, ssh_executable)| {
                RemoteTunnelHost::new(host.clone(), ssh_executable.to_path_buf())
            });
        let env = if app_server_host.is_remote() {
            EnvironmentContext::capture_remote(app_server_host.cwd().to_path_buf())
        } else {
            local_env
        };
        let mut files = FilesState::default();
        files.set_dir_root(env.working_directory().to_path_buf());
        let mut scm = ScmState::default();
        scm.set_branch(Some(env.git_branch_label()).filter(|branch| *branch != "No Git"));
        scm.replace_diffs(env.diffs().iter().map(|diff| {
            ScmDiff::new(diff.path(), diff.document().clone()).with_staging(diff.staging())
        }));
        let keybindings = keybindings::WorkbenchKeybindings::default();
        let mut session_pane = SessionPaneState::for_working_directory(env.working_directory());
        let history_proxy = event_proxy.clone();
        let history = (|| {
            let runtime = ::state::StateRuntime::open(
                ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let store = ::state::SqliteMessageHistory::open(
                runtime.database_path(),
                message_history::MessageHistoryRetention::default(),
            )?;
            message_history::MessageHistory::with_waker(Arc::new(store), move || {
                let _ = history_proxy.send_event(WorkbenchEvent::InputHistoryReady);
            })
            .map_err(|error| error.to_string())
        })();
        match history {
            Ok(history) => session_pane.connect_input_history(history),
            Err(error) => session_pane
                .input_history_unavailable(format!("Could not open input history: {error}")),
        }
        let language_events = Arc::new(language_service_adapter::WorkbenchLanguageEventSink::new(
            event_proxy.clone(),
        ));
        let language_service = if launch.is_remote() {
            FileEditorLanguageService::remote(env.working_directory(), language_events)
        } else {
            FileEditorLanguageService::start(env.working_directory(), language_events)
        };
        Self {
            window: None,
            memory: crate::memory::MemoryUi::new(&application),
            memories: crate::memories::MemoriesUi::new(&application),
            presentation: None,
            frame_scheduler: FrameScheduler::default(),
            retained_runtime: RetainedRuntime::default(),
            files,
            scm,
            files_pane_expanded: false,
            file_editor_input: FileEditorInputState::default(),
            file_editor_search: FileEditorSearchState::default(),
            language_service,
            file_editor_host: FileEditorHost::default(),
            session_search: SessionSearchState::default(),
            workbench: WorkbenchHost::new(),
            terminal_runtime: {
                let terminal_event_proxy = event_proxy.clone();
                let terminal_target = app_server_host
                    .remote_connection()
                    .cloned()
                    .map(ash_terminal_runtime::TerminalRuntimeTarget::remote)
                    .unwrap_or(ash_terminal_runtime::TerminalRuntimeTarget::Local);
                TerminalRuntime::new(
                    move |key, size| {
                        let event_proxy = terminal_event_proxy.clone();
                        let event_sink: ash_terminal_runtime::TerminalEventSink =
                            Arc::new(move |event| event_proxy.send_event(event.into()).is_ok());
                        TerminalSession::spawn_async(
                            key,
                            size,
                            event_sink,
                            terminal_target.clone(),
                            APP_DISPLAY_NAME.to_owned(),
                        )
                    },
                    TerminalSession::resize,
                )
            },
            terminal_pane_views: TerminalPaneViews::default(),
            git_branch_picker: GitBranchPickerState::default(),
            directory_picker: DirectoryPickerState::default(),
            remote_connection_picker: RemoteConnectionPickerState::default(),
            remote_connection_manager: RemoteConnectionManagerState::default(),
            remote_connection_launch: None,
            remote_tunnel_manager: RemoteTunnelManagerState::default(),
            remote_tunnel_host,
            ui_dispatch: UiDispatch::default(),
            session_runtime: None,
            app_server_client: None,
            app_server_host: app_server_host.clone(),
            session_pane,
            classification_task: None,
            main_surface: MainSurface::default(),
            env,
            text_layout: TextInputLayoutEngine::new(),
            caret_blink: CaretBlinkController::default(),
            code_editor_style: CodeEditorStyle::light(),
            gui: GuiConfig::default(),
            event_proxy,
            clipboard,
            cursor_position: None,
            keybindings,
            keybinding_diagnostics: Vec::new(),
            quick_access: QuickAccess::default(),
            settings: SettingsState::default(),
            modifiers: ModifiersState::default(),
            pending_focus: None,
            physical_extent: PhysicalExtent::new(0, 0),
            scale_factor: 1.0,
            failed: false,
            palette: DEFAULT_UI_THEME,
            typography: DEFAULT_UI_TYPOGRAPHY.clone(),
            theme_scheme: ColorScheme::Light,
            system_theme_scheme: ColorScheme::Light,
            theme_follows_system: true,
        }
    }
}
