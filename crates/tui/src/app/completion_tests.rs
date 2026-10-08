use super::report_turn_start_failure;
use crate::app::App;
use crate::app::Status;
use crate::keymap::KeyEvent;
use ash_protocol::TurnId;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;

#[test]
fn invalid_complete_tui_reload_preserves_settings_and_draft_in_both_modes() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = App::for_dir(std::path::Path::new("/work/ash"));
        let mut terminal = crate::config::TerminalSettings::default();
        terminal.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(terminal));
        app.insert_text("keep this draft");
        let before = app
            .status_line()
            .top_text_for_width(80, app.status_line_runtime());
        let mut config = crate::test_support::empty_config_snapshot();
        config
            .tui
            .0
            .insert("language".into(), serde_json::json!("zh-CN"));
        config
            .tui
            .0
            .insert("screenMode".into(), serde_json::json!("inline"));
        config
            .tui
            .0
            .insert("statusLine".into(), serde_json::json!([]));
        config
            .tui
            .0
            .insert("showTip".into(), serde_json::json!(false));
        super::apply_tui_config(config, None, &mut app);
        assert_eq!(app.screen_mode(), mode);
        assert_eq!(app.language(), crate::nls::Language::English);
        assert_eq!(
            app.status_line()
                .top_text_for_width(80, app.status_line_runtime()),
            before
        );
        assert_eq!(app.input(), "keep this draft");
        assert_eq!(app.status(), &Status::Ready);
        assert!(
            app.messages()
                .last()
                .unwrap()
                .text()
                .contains("未知的 [tui] 配置键：showTip。")
        );

        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 16)).unwrap();
        terminal
            .draw(|frame| crate::app::frame::draw(frame, &app))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = (0..16)
            .map(|y| (0..80).map(|x| buffer[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        crate::tui_assert_snapshot!(app = &app; "invalid_tui_configuration", text);
    }
}

#[test]
fn invalid_tui_reload_does_not_mark_the_running_turn_as_failed() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.insert_text("start this turn");
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let turn = TurnId::new("running-turn").unwrap();
        app.set_active_turn(turn.clone());
        app.insert_text("keep this follow-up");
        let mut config = crate::test_support::empty_config_snapshot();
        config
            .tui
            .0
            .insert("showTip".into(), serde_json::json!(false));

        super::apply_tui_config(config, None, &mut app);

        assert_eq!(app.active_turn(), Some(&turn));
        assert_eq!(app.status(), &Status::Working);
        assert_eq!(app.input(), "keep this follow-up");
        assert_eq!(app.screen_mode(), mode);
        assert!(app.messages().last().unwrap().text().contains("showTip"));
    }
}

#[test]
fn turn_start_failure_preserves_an_active_turn_that_appeared_during_the_request() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.set_active_turn(TurnId::new("turn_1").unwrap());

    report_turn_start_failure(&mut app, "sequence conflict".into());

    assert_eq!(app.status(), &Status::Working);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .text()
            .contains("could not start the Turn: sequence conflict")
    );
}

#[test]
fn initial_turn_failure_enters_error_state() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    report_turn_start_failure(&mut app, "server unavailable".into());

    assert_eq!(app.status(), &Status::Error);
}

#[test]
fn collaboration_effort_completion_preserves_the_running_turn_and_draft() {
    let mut app = App::new();
    app.set_active_turn(TurnId::new("running").unwrap());
    app.update(crate::thread::Event::TurnActivityChanged(
        crate::thread::TurnActivity::Working,
    ));
    app.set_collaboration_mode(ash_protocol::CollaborationMode::Plan);
    app.insert_text("next task draft");
    let rows = app.messages().len();
    let config = crate::test_support::empty_config_snapshot();
    let origin = crate::app::requests::RequestOrigin {
        mode: crate::terminal::ScreenMode::Fullscreen,
        panel_generation: app.panels().generation(),
    };
    super::apply_request_completion(
        super::Completion::ModelUpdated {
            command: crate::models::Command::IncreaseEffort,
            result: Ok(crate::models::ModelUpdate {
                catalog: None,
                summary: crate::models::ModelSummary::from_catalog(
                    Some(ash_app_server_protocol::protocol::config::ModelRefDto {
                        provider: "openai".into(),
                        model: "test-model".into(),
                    }),
                    Some(ash_protocol::ReasoningEffort::High),
                    None,
                ),
                notice: crate::models::ModelNotice::Silent,
                picker: None,
                config,
            }),
        },
        origin,
        &mut None,
        &mut app,
    );
    assert_eq!(app.status(), &Status::Working);
    assert!(app.steers_active_turn());
    assert_eq!(
        app.collaboration_mode(),
        ash_protocol::CollaborationMode::Plan
    );
    assert_eq!(app.input(), "next task draft");
    assert_eq!(app.messages().len(), rows);
    assert_eq!(app.status_line().model_label(), "test-model (high)");
    assert_eq!(app.top_tip().text(None), None);
    super::apply_request_completion(
        super::Completion::ModelUpdated {
            command: crate::models::Command::DecreaseEffort,
            result: Err("This model does not support thinking effort".into()),
        },
        origin,
        &mut None,
        &mut app,
    );
    assert_eq!(app.status(), &Status::Working);
    assert!(app.steers_active_turn());
    assert_eq!(app.input(), "next task draft");
    assert_eq!(app.messages().len(), rows + 1);
}

#[test]
fn model_option_failure_is_visible_without_interrupting_the_turn_or_draft() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.set_active_turn(TurnId::new("running").unwrap());
        app.update(crate::thread::Event::TurnActivityChanged(
            crate::thread::TurnActivity::Working,
        ));
        app.insert_text("keep draft");
        let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
            catalog_scopes: None,
            models: vec![],
        };
        app.update(crate::models::Event::PickerOpened(
            crate::models::model_choices(&catalog, &crate::test_support::empty_config_snapshot())
                .unwrap(),
        ));
        let origin = crate::app::requests::RequestOrigin {
            mode,
            panel_generation: app.panels().generation(),
        };
        super::apply_request_completion(
            super::Completion::ModelUpdated {
                command: crate::models::Command::Configure {
                    preference: "openai/gpt-6-astra".into(),
                    revision: 7,
                    option: crate::models::ModelOption::Acceleration(Some("priority".into())),
                },
                result: Err("Model settings changed; reopen /model and try again".into()),
            },
            origin,
            &mut None,
            &mut app,
        );
        assert_eq!(app.status(), &Status::Working);
        assert_eq!(app.input(), "keep draft");
        assert_eq!(
            app.command_panel()
                .unwrap()
                .list_selection()
                .unwrap()
                .message(),
            Some("模型设置已更改，请重新打开 /model 后重试")
        );
    }
}

#[test]
fn status_line_context_follows_thread_snapshots() {
    use ash_protocol::ModelContextUsage;
    use ash_protocol::ModelContextUsageSource;
    use ash_protocol::ModelId;
    use ash_protocol::ModelRef;
    use ash_protocol::ProviderId;
    let model = ModelRef::new(
        ProviderId::new("provider").unwrap(),
        ModelId::new("model").unwrap(),
    );
    let mut snapshot = ash_protocol::Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "thread".into(),
        status: ash_protocol::ThreadStatus::Active,
        sequence: 1,
        usage: Default::default(),
        reference_cost: Default::default(),
        goal: None,
        turns: vec![ash_protocol::Turn {
            mode: Default::default(),
            advisor: None,
            turn_id: TurnId::new("turn").unwrap(),
            status: ash_protocol::TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: Some(model),
            reasoning_effort: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::Manual,
            usage: Default::default(),
            context_usage: Some(ModelContextUsage {
                used_tokens: 40,
                source: ModelContextUsageSource::ProviderReported,
            }),
            items: vec![],
            plan: None,
            pending_interaction: None,
            error: None,
        }],
    };
    let mut app = App::new();
    let mut settings = crate::status::StatusLineSettings::default();
    for item in crate::status::StatusLineItem::ALL {
        settings.set(item, item == crate::status::StatusLineItem::Context);
    }
    let mut config = crate::test_support::empty_config_snapshot();
    config.tui = settings.write_to_tui(&config.tui);
    config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
        provider: "provider".into(),
        model: "model".into(),
    });
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        catalog_scopes: None,
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                retirement: None,
                description: None,
                discovered: None,
                model: snapshot.turns[0].model.clone().unwrap(),
                display_name: "model".into(),

                context_window: Some(100),

                maximum_context_window: Some(100),
                default_context_window: Some(100),
                long_context: None,
                selected_acceleration: None,
                acceleration_options: Vec::new(),
                auto_compact_token_limit: None,
                available_context_window: Some(100),
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                settings: Default::default(),
                supported_reasoning_efforts: vec![],
                default_reasoning_effort: None,
                default_personality: None,
            },
        ],
    };
    super::apply_tui_config(config.clone(), Some(&catalog), &mut app);
    super::apply_thread_snapshot_parts(&mut app, snapshot.clone(), None);
    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "context 40%"
    );
    super::apply_tui_config(config, Some(&catalog), &mut app);
    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "context 40%"
    );
    snapshot.thread_id = ash_protocol::ThreadId::new("other").unwrap();
    snapshot.turns.clear();
    super::apply_thread_snapshot_parts(&mut app, snapshot, None);
    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "context unknown"
    );
}
