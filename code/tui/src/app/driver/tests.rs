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
    let dictation_settings = Arc::new(
        crate::config::LocalDictationSettings::open(root.path(), runtime.database_path()).unwrap(),
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
            dictation_settings,
            model_picker,
        },
    );
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
