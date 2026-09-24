use super::ActiveConversation;
use super::App;
use super::completion::apply_thread_snapshot;
use super::completion::apply_tui_config;
use super::driver::AppDriver;
use super::driver::AppDriverResources;
use super::event_pump::EventPump;
use crate::AppServerProcess;
use crate::TuiError;
use crate::TuiOptions;
use crate::sessions;
use crate::sessions::Event as SessionEvent;
use crate::skills::Event as SkillEvent;
use crate::status::Event as StatusEvent;
use crate::terminal::TerminalSession;
use crate::theme as theme_feature;
use crate::theme::Event as ThemeEvent;
use crate::theme::ThemeResource;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadSubscription;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::chat_input_catalog_snapshot;
use crate::thread::composer::file_search::FileSearchManager;
use crate::thread::composer::slash_command_registry;
use ash_app_server_client::AppServerSession;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_app_server_protocol::protocol::skills::SkillListParams;
use ash_memory_diagnostics::ProcessResourceTargets;

pub(super) struct StartedSession {
    pub(super) driver: AppDriver,
    pub(super) pump: EventPump,
    pub(super) terminal: TerminalSession,
}

pub(super) fn start(
    session: &mut AppServerSession,
    options: TuiOptions,
) -> Result<StartedSession, TuiError> {
    let mut client = session.client();
    let events = session.take_events()?;
    let startup_context = options.startup_context();
    let TuiOptions {
        thread_title,
        display_dir_root,
        host_dir_root,
        host_file_search_root,
        theme_root,
        profile_root,
        app_server_process,
        recovery,
        drafts,
        notices,
        ..
    } = options;
    let profile_root = match profile_root {
        Some(root) => ash_utils_home_dir::resolve_path(&root)?,
        None => ash_utils_home_dir::find_ash_home()?,
    };
    let initialization = client.initialization()?;
    let server_slash_commands = initialization.slash_commands.clone();
    let plugins_enabled = initialization.capabilities.plugins;
    let plugins = if plugins_enabled {
        client.list_plugins()?.packages
    } else {
        Vec::new()
    };
    let initial_skill_catalog = client
        .list_skills(SkillListParams {
            reload: SkillCatalogReloadDto::Cached,
            session_id: None,
        })
        .ok();
    let input_catalog = initial_skill_catalog
        .as_ref()
        .and_then(|catalog| {
            chat_input_catalog_snapshot(&server_slash_commands, catalog, &plugins).ok()
        })
        .unwrap_or(ChatInputCatalog::with_slash_commands(
            slash_command_registry(&server_slash_commands)?,
        ));
    let initial_skill_diagnostics = initial_skill_catalog
        .map(|catalog| catalog.diagnostics)
        .unwrap_or_default();
    let initial_config = client.read_config()?;
    let terminal_settings = crate::config::TerminalSettings::from_tui(&initial_config.tui)
        .map_err(std::io::Error::other)?;
    let show_home = recovery.is_none()
        && terminal_settings.screen_mode() == crate::terminal::ScreenMode::Fullscreen;
    let initial = match recovery {
        Some(recovery) => Some(ActiveConversation::recover(&mut client, recovery)?),
        None if !show_home => Some(ActiveConversation::start(&mut client, thread_title)?),
        None => None,
    }
    .map(|mut conversation| {
        let (subscription, thread, transcript) = ThreadSubscription::start(
            &mut client,
            conversation.session_id(),
            conversation.thread_id(),
        )?;
        conversation.set_thread_sequence(thread.sequence);
        Ok::<_, TuiError>((
            crate::sessions::Conversation {
                conversation,
                subscription,
            },
            thread,
            transcript,
        ))
    })
    .transpose()?;
    let terminal = TerminalSession::open(terminal_settings.screen_mode())?;
    let theme_resource = match theme_root {
        Some(theme_root) => ThemeResource::in_product_root(theme_root, terminal.background_color()),
        None => ThemeResource::in_product_root(
            profile_root.join("ash-code"),
            terminal.background_color(),
        ),
    };
    let file_search = host_file_search_root.map(FileSearchManager::new);
    let mut app = App::for_dir_with_input_catalog_and_startup_context(
        &display_dir_root,
        input_catalog,
        startup_context,
    );
    let history = (|| {
        let runtime =
            state::StateRuntime::open(&profile_root).map_err(|error| error.to_string())?;
        let store = state::SqliteMessageHistory::open(
            runtime.database_path(),
            message_history::MessageHistoryRetention::default(),
        )?;
        message_history::MessageHistory::new(std::sync::Arc::new(store))
            .map_err(|error| error.to_string())
    })();
    match history {
        Ok(history) => app.connect_input_history(history),
        Err(error) => {
            app.input_history_unavailable(format!("Could not open input history: {error}"))
        }
    }
    let initial_model_catalog = client.list_models().ok();
    let theme_preference = theme_feature::preference(&initial_config);
    match theme_resource.load(theme_preference) {
        Ok(loaded) => {
            for diagnostic in loaded.diagnostics {
                eprintln!("theme: {diagnostic}");
            }
            app.update(ThemeEvent::RenderChanged(loaded.theme));
        }
        Err(error) => app.update(ThreadEvent::FailureReported(error)),
    }
    apply_tui_config(initial_config, initial_model_catalog.as_ref(), &mut app);
    match sessions::load_catalog(&mut client) {
        Ok(catalog) => app.update(SessionEvent::CatalogReceived(catalog)),
        Err(error) => app.update(ThreadEvent::FailureReported(format!(
            "could not load Sessions: {error}"
        ))),
    }
    let conversation = initial.map(|(conversation, thread, transcript)| {
        apply_thread_snapshot(&mut app, thread, transcript);
        conversation
    });
    if show_home && terminal_settings.screen_mode() == crate::terminal::ScreenMode::Fullscreen {
        app.open_home();
    }
    if let Some(drafts) = drafts {
        app.restore_recovery_drafts(drafts);
    }
    app.update(SkillEvent::DiagnosticsReceived(initial_skill_diagnostics));
    if let Ok(status) = client.git_status() {
        app.update(StatusEvent::GitStatusReceived(status));
    }
    if app.request_status_line_git_text_diff()
        && let Ok(result) = client.git_text_diff()
    {
        app.update(StatusEvent::GitTextDiffReceived {
            status: result.status,
            statistics: result.statistics,
        });
    }

    let resource_targets = process_resource_targets(app_server_process);
    let driver = AppDriver::new(
        app,
        client,
        conversation,
        AppDriverResources {
            file_search,
            host_dir_root,
            theme_resource,
            server_slash_commands,
            plugins_enabled,
        },
    );
    let pump = EventPump::start(events, resource_targets, notices)?;
    Ok(StartedSession {
        driver,
        pump,
        terminal,
    })
}

const fn process_resource_targets(process: AppServerProcess) -> ProcessResourceTargets {
    match process {
        AppServerProcess::Local(process_id) => ProcessResourceTargets::CurrentAndTree(process_id),
        AppServerProcess::IncludedInTui | AppServerProcess::Remote => {
            ProcessResourceTargets::Current
        }
    }
}

#[cfg(test)]
#[path = "start_tests.rs"]
mod tests;
