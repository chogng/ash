#[cfg(feature = "in-process-tests")]
use super::AppDriver;
#[cfg(feature = "in-process-tests")]
use super::AppDriverResources;
use super::ScheduledCommand;
use super::schedule_command as schedule;
use crate::app::requests::RequestOrigin;

fn origin() -> RequestOrigin {
    RequestOrigin {
        mode: crate::terminal::ScreenMode::Fullscreen,
        panel_generation: 0,
    }
}

fn scheduled(command: AppCommand) -> ScheduledCommand {
    ScheduledCommand {
        command,
        origin: origin(),
    }
}

fn schedule_command(
    command: Option<AppCommand>,
    requests: &RequestTasks,
    queued: &mut VecDeque<ScheduledCommand>,
) -> Option<AppCommand> {
    schedule(command.map(scheduled), requests, queued).map(|scheduled| scheduled.command)
}
use crate::app::App;
use crate::app::AppCommand;
#[cfg(feature = "in-process-tests")]
use crate::app::AppEvent;
use crate::app::completion::Completion;
use crate::app::requests::RequestKey;
use crate::app::requests::RequestTasks;
use crate::host::Command as HostCommand;
use crate::keymap_setup::Command as KeymapCommand;
use crate::theme::Command as ThemeCommand;
use crate::thread::Command as ThreadCommand;
#[cfg(feature = "in-process-tests")]
use crate::thread::composer::SlashCommandInvocation;
#[cfg(feature = "in-process-tests")]
use crate::thread::composer::TuiSlashCommandAction;
#[cfg(feature = "in-process-tests")]
use crate::thread::composer::built_in_catalog_command;
#[cfg(feature = "in-process-tests")]
use ash_app_server_client::AppServerSession;
#[cfg(feature = "in-process-tests")]
use ash_app_server_client::InProcessClientOptions;
#[cfg(feature = "in-process-tests")]
use ash_app_server_protocol::protocol::common::ClientInfo;
#[cfg(feature = "in-process-tests")]
use ash_slash_commands::SlashCommandOrigin;
#[cfg(feature = "in-process-tests")]
use ratatui::Terminal;
#[cfg(feature = "in-process-tests")]
use ratatui::backend::TestBackend;
use std::collections::VecDeque;
#[cfg(feature = "in-process-tests")]
use std::sync::Arc;

#[test]
#[cfg(feature = "in-process-tests")]
fn repeated_model_command_opens_the_fixed_catalog_without_loading() {
    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let session = AppServerSession::start_embedded(InProcessClientOptions::new(
        root.path(),
        ClientInfo {
            name: "ash-tui-model-picker-test".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let mut client = session.client();
    let model_picker = crate::models::ModelPickerData::new(
        client.list_models().unwrap(),
        client.read_config().unwrap(),
    );
    let runtime = state::StateRuntime::open(root.path()).unwrap();
    let local_settings = Arc::new(
        crate::config::LocalTuiSettings::open(root.path(), runtime.database_path()).unwrap(),
    );
    let mut driver = AppDriver::new(
        App::new(),
        client,
        None,
        AppDriverResources {
            file_search: None,
            host_dir_root: root.path().to_path_buf(),
            theme_resource: crate::theme::ThemeResource::in_product_root(
                root.path().to_path_buf(),
                None,
            ),
            server_slash_commands: Vec::new(),
            plugins_enabled: false,
            local_settings,
            model_picker,
        },
    )
    .unwrap();
    driver.queued_commands.clear();

    for _ in 0..2 {
        let invocation = SlashCommandInvocation {
            mode: Default::default(),
            command: built_in_catalog_command(TuiSlashCommandAction::Model),
            origin: SlashCommandOrigin::Local,
            display_arguments: String::new(),
            arguments: Vec::new(),
        };
        let command = ThreadCommand::ExecuteProductCommand(invocation).into();
        assert!(driver.next_command(Some(command), false).is_none());
        assert_eq!(driver.app().list_selection().unwrap().title(), "Model");
        assert!(
            !driver
                .app()
                .list_selection()
                .unwrap()
                .visible_items()
                .is_empty()
        );
        assert!(driver.requests.is_idle(Some(RequestKey::Config)));
        driver.app_mut().update(AppEvent::CommandPanelClosed);
    }

    let invocation = SlashCommandInvocation {
        mode: Default::default(),
        command: built_in_catalog_command(TuiSlashCommandAction::Model),
        origin: SlashCommandOrigin::Local,
        display_arguments: String::new(),
        arguments: Vec::new(),
    };
    driver.next_command(
        Some(ThreadCommand::ExecuteProductCommand(invocation).into()),
        false,
    );
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, driver.app()))
        .unwrap();
    crate::tui_assert_snapshot!(app = driver.app();
        "model_command_opens_fixed_catalog_immediately",
        terminal.backend().to_string()
    );
}

#[test]
#[cfg(feature = "in-process-tests")]
fn effort_command_opens_the_supported_selector_without_loading() {
    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let session = AppServerSession::start_embedded(InProcessClientOptions::new(
        root.path(),
        ClientInfo {
            name: "ash-tui-effort-selector-test".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let mut client = session.client();
    let model_picker = crate::models::ModelPickerData::new(
        client.list_models().unwrap(),
        client.read_config().unwrap(),
    );
    let runtime = state::StateRuntime::open(root.path()).unwrap();
    let local_settings = Arc::new(
        crate::config::LocalTuiSettings::open(root.path(), runtime.database_path()).unwrap(),
    );
    let mut driver = AppDriver::new(
        App::new(),
        client,
        None,
        AppDriverResources {
            file_search: None,
            host_dir_root: root.path().to_path_buf(),
            theme_resource: crate::theme::ThemeResource::in_product_root(
                root.path().to_path_buf(),
                None,
            ),
            server_slash_commands: Vec::new(),
            plugins_enabled: false,
            local_settings,
            model_picker,
        },
    )
    .unwrap();
    driver.queued_commands.clear();

    let mut config = driver.client.read_config().unwrap();
    let entry = driver
        .model_picker
        .catalog()
        .models
        .iter()
        .find(|entry| !entry.supported_reasoning_efforts.is_empty())
        .unwrap();
    config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
        provider: entry.model.provider.to_string(),
        model: entry.model.model.to_string(),
    });
    config.model_reasoning_effort = entry.supported_reasoning_efforts.last().copied();
    driver.model_picker.update_config(config);
    driver.app_mut().insert_text("/effort");
    let command = driver.app_mut().handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    ));
    assert_eq!(
        command,
        Some(crate::models::Command::OpenEffortPicker.into())
    );
    assert!(driver.next_command(command, false).is_none());
    assert!(matches!(
        driver.app().command_panel(),
        Some(crate::app::command_panel::CommandPanel::Effort(_))
    ));
    assert!(driver.requests.is_idle(Some(RequestKey::Config)));
}

#[test]
fn unrelated_actions_bypass_a_busy_request_without_losing_same_domain_order() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    let (release, wait) = std::sync::mpsc::sync_channel(0);
    requests.spawn(
        Some(RequestKey::Config),
        "ash-tui-test-write",
        move || {
            wait.recv().expect("the test releases the write request");
            Completion::Presentation(Err("finished".into()))
        },
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();
    let write = ThemeCommand::Set {
        preference: "ash-code-dark".into(),
    }
    .into();

    assert!(schedule_command(Some(write), &requests, &mut queued).is_none());
    assert!(matches!(
        schedule_command(
            Some(KeymapCommand::OpenEditor.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Keymap(KeymapCommand::OpenEditor))
    ));
    assert!(matches!(
        schedule_command(
            Some(ThreadCommand::Interrupt.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    ));
    assert_eq!(queued.len(), 1);
    release
        .send(())
        .expect("the write request remains alive until released");
    let completed = (0..10_000)
        .find_map(|_| {
            let completed = requests.poll();
            if completed.is_empty() {
                std::thread::yield_now();
                None
            } else {
                Some(completed)
            }
        })
        .expect("the released write request completes");
    assert_eq!(completed.len(), 1);
    assert!(matches!(
        schedule_command(None, &requests, &mut queued),
        Some(AppCommand::Theme(ThemeCommand::Set { .. }))
    ));
}

#[test]
fn interrupt_bypasses_an_active_interaction_response() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    let (release, wait) = std::sync::mpsc::sync_channel(0);
    requests.spawn(
        Some(RequestKey::Interaction),
        "ash-tui-test-interaction",
        move || {
            wait.recv()
                .expect("the test releases the interaction request");
            Completion::Presentation(Err("finished".into()))
        },
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();

    assert!(matches!(
        schedule_command(
            Some(ThreadCommand::Interrupt.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    ));
    release
        .send(())
        .expect("the interaction request remains alive until released");
    let completed = (0..10_000)
        .find_map(|_| {
            let completed = requests.poll();
            if completed.is_empty() {
                std::thread::yield_now();
                None
            } else {
                Some(completed)
            }
        })
        .expect("the released interaction request completes");
    assert_eq!(completed.len(), 1);
}

#[test]
fn quit_bypasses_a_pending_request() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    requests.spawn(
        Some(RequestKey::Config),
        "ash-tui-test-write",
        || Completion::Presentation(Err("finished".into())),
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();

    assert!(matches!(
        schedule_command(Some(AppCommand::Quit), &requests, &mut queued),
        Some(AppCommand::Quit)
    ));
    assert!(queued.is_empty());
}

#[test]
fn repeated_clipboard_availability_refreshes_are_coalesced() {
    let requests = RequestTasks::default();
    let mut queued = VecDeque::from([scheduled(AppCommand::from(
        HostCommand::RefreshClipboardImageAvailability,
    ))]);

    let action = schedule_command(
        Some(HostCommand::RefreshClipboardImageAvailability.into()),
        &requests,
        &mut queued,
    );

    assert_eq!(
        action,
        Some(AppCommand::Host(
            HostCommand::RefreshClipboardImageAvailability
        ))
    );
    assert!(queued.is_empty());
}

#[test]
fn repeated_older_history_requests_are_coalesced() {
    let requests = RequestTasks::default();
    let mut queued = VecDeque::from([scheduled(AppCommand::from(ThreadCommand::LoadOlderHistory))]);

    let action = schedule_command(
        Some(ThreadCommand::LoadOlderHistory.into()),
        &requests,
        &mut queued,
    );

    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::LoadOlderHistory))
    );
    assert!(queued.is_empty());
}

#[test]
fn queued_work_and_completion_keep_the_origin_recorded_before_a_mode_switch() {
    let mut app = App::new();
    let expected = RequestOrigin::current(&app);
    let mut queued = VecDeque::from([ScheduledCommand::new(
        ThreadCommand::LoadOlderHistory.into(),
        &app,
    )]);
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    let mut requests = RequestTasks::default();
    let scheduled = schedule(None, &requests, &mut queued).unwrap();
    assert_eq!(scheduled.origin, expected);
    assert_ne!(scheduled.origin.mode, app.screen_mode());
    let (release, wait) = std::sync::mpsc::channel();
    requests.spawn(
        Some(RequestKey::Thread),
        "ash-tui-origin-test",
        move || {
            wait.recv().unwrap();
            Completion::Presentation(Ok(
                crate::thread::Event::ProductNotice("finished".into()).into()
            ))
        },
        &mut app,
        scheduled.origin,
    );
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let completion = loop {
        if let Some(completion) = requests.poll().pop() {
            break completion.unwrap();
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    };
    assert_eq!(completion.origin, expected);
}

#[test]
#[cfg(feature = "in-process-tests")]
fn switch_mode_updates_the_composer_without_overwriting_the_next_message_choice() {
    use ash_protocol::CollaborationMode;
    use ash_protocol::ThreadEvent;
    use ash_protocol::ThreadUpdate;
    use ash_protocol::ThreadUpdateEnvelope;

    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let session = AppServerSession::start_embedded(InProcessClientOptions::new(
        root.path(),
        ClientInfo {
            name: "ash-tui-switch-mode-test".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let mut client = session.client();
    let active =
        crate::sessions::ActiveConversation::start(&mut client, "Mode switch".into()).unwrap();
    let (subscription, snapshot, _) = crate::thread::ThreadSubscription::start(
        &mut client,
        active.session_id(),
        active.thread_id(),
    )
    .unwrap();
    let mut current = crate::sessions::Conversation {
        conversation: active,
        subscription,
    };
    let update = ThreadUpdateEnvelope {
        session_id: snapshot.session_id,
        thread_id: snapshot.thread_id.clone(),
        durable_sequence: snapshot.sequence + 1,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::TurnModeChanged {
                thread_id: snapshot.thread_id,
                turn_id: ash_protocol::TurnId::new("switch-turn").unwrap(),
                from_mode: CollaborationMode::Agent,
                mode: CollaborationMode::Plan,
                instructions: ash_protocol::TurnInstructions::new(
                    "test",
                    "mode",
                    "1",
                    "Plan the task.",
                )
                .unwrap(),
            },
        },
    };
    for selected in [CollaborationMode::Agent, CollaborationMode::Ask] {
        let mut app = App::new();
        app.set_active_turn(ash_protocol::TurnId::new("switch-turn").unwrap());
        app.set_collaboration_mode(selected);
        let refresh = super::refresh_server_event(
            crate::client::ClientEvent::ThreadUpdated(Box::new(update.clone())),
            Some(&mut current),
            &mut app,
        );
        assert!(refresh.thread);
        assert_eq!(
            app.collaboration_mode(),
            if selected == CollaborationMode::Agent {
                CollaborationMode::Plan
            } else {
                selected
            }
        );
    }
}

#[test]
#[cfg(feature = "in-process-tests")]
fn dashboard_grouping_saves_and_restores_at_driver_startup_independently_of_server_profile() {
    let _guard = crate::test_support::in_process_test_guard();
    let server_root = tempfile::tempdir().unwrap();
    let local_root = tempfile::tempdir().unwrap();
    let local_path = local_root.path().join("config.toml");
    std::fs::write(
        &local_path,
        "[tui]\nsessionGrouping = \"model\"\nshowTips = false\n",
    )
    .unwrap();
    let session = AppServerSession::start_embedded(InProcessClientOptions::new(
        server_root.path(),
        ClientInfo {
            name: "ash-tui-grouping-test".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let mut client = session.client();
    let catalog = client.list_models().unwrap();
    let remote_config = client.read_config().unwrap();
    let runtime = state::StateRuntime::open(local_root.path()).unwrap();
    let local_settings = Arc::new(
        crate::config::LocalTuiSettings::open(local_root.path(), runtime.database_path()).unwrap(),
    );
    let mut driver = AppDriver::new(
        App::new(),
        client.clone(),
        None,
        AppDriverResources {
            file_search: None,
            host_dir_root: local_root.path().into(),
            theme_resource: crate::theme::ThemeResource::in_product_root(
                local_root.path().into(),
                None,
            ),
            server_slash_commands: Vec::new(),
            plugins_enabled: false,
            local_settings: Arc::clone(&local_settings),
            model_picker: crate::models::ModelPickerData::new(
                catalog.clone(),
                remote_config.clone(),
            ),
        },
    )
    .unwrap();
    assert_eq!(
        driver.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Model
    );
    driver.app_mut().show_session_manager();
    driver
        .app_mut()
        .session_navigation_mut()
        .manager_mut()
        .focus();
    let command = driver
        .app_mut()
        .handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('g'),
            crossterm::event::KeyModifiers::NONE,
        ))
        .unwrap();
    driver.execute(scheduled(command));
    assert_eq!(
        local_settings.read_grouping().unwrap(),
        crate::sessions::SessionGrouping::Project
    );
    assert_eq!(client.read_config().unwrap().tui, remote_config.tui);
    drop(driver);
    let mut restarted = AppDriver::new(
        App::new(),
        client,
        None,
        AppDriverResources {
            file_search: None,
            host_dir_root: local_root.path().into(),
            theme_resource: crate::theme::ThemeResource::in_product_root(
                local_root.path().into(),
                None,
            ),
            server_slash_commands: Vec::new(),
            plugins_enabled: false,
            local_settings: Arc::clone(&local_settings),
            model_picker: crate::models::ModelPickerData::new(catalog, remote_config),
        },
    )
    .unwrap();
    assert_eq!(
        restarted.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Project
    );
    assert_eq!(
        restarted.app().inline.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Project
    );
    let saved_document = std::fs::read_to_string(&local_path).unwrap();
    assert!(saved_document.contains("showTips = false"));
    restarted.poll_request_completions();
    restarted.app_mut().show_session_manager();
    std::fs::remove_file(&local_path).unwrap();
    std::fs::create_dir(&local_path).unwrap();
    let command = restarted
        .app_mut()
        .handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('g'),
            crossterm::event::KeyModifiers::NONE,
        ))
        .unwrap();
    restarted.execute(scheduled(command));
    assert_eq!(
        restarted.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Status
    );
    assert!(
        restarted
            .app()
            .top_tip()
            .text(None)
            .unwrap()
            .contains("Could not save dashboard grouping")
    );
    std::fs::remove_dir(&local_path).unwrap();
    std::fs::write(
        &local_path,
        saved_document.replace("showTips = false", "showTips = true"),
    )
    .unwrap();
    local_settings.read_grouping().unwrap();
    restarted.poll_request_completions();
    assert_eq!(
        restarted.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Status
    );
    let external_document = std::fs::read_to_string(&local_path).unwrap().replace(
        "sessionGrouping = \"project\"",
        "sessionGrouping = \"model\"",
    );
    std::fs::write(&local_path, external_document).unwrap();
    assert_eq!(
        local_settings.read_grouping().unwrap(),
        crate::sessions::SessionGrouping::Model
    );
    restarted.poll_request_completions();
    assert_eq!(
        restarted.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Model
    );
    assert_eq!(
        restarted.app().inline.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Model
    );
    let invalid_document = std::fs::read_to_string(&local_path).unwrap().replace(
        "sessionGrouping = \"model\"",
        "sessionGrouping = \"invalid\"",
    );
    std::fs::write(&local_path, invalid_document).unwrap();
    assert!(local_settings.read_grouping().is_err());
    restarted.poll_request_completions();
    assert_eq!(
        restarted.app().fullscreen.sessions.manager().grouping(),
        crate::sessions::SessionGrouping::Model
    );
    assert_eq!(restarted.app().status(), &crate::app::Status::Ready);
}
