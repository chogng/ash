use super::report_turn_start_failure;
use crate::app::App;
use crate::app::Status;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ash_protocol::TurnId;

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
            turn_id: TurnId::new("turn").unwrap(),
            status: ash_protocol::TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: Some(model),
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
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
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                model: snapshot.turns[0].model.clone().unwrap(),
                display_name: "model".into(),
                access: ash_protocol::ModelAccess::ApiKey,
                output_transport: ash_protocol::ModelOutputTransport::Unary,
                context_window: Some(100),
                auto_compact_token_limit: None,
                available_context_window: Some(100),
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: vec![],
                model_reasoning_effort: None,
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
