use super::app::App;
use super::app::Status;
use crate::app::apply_active_turn_snapshot;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::composer::chat_input_catalog_snapshot;
use crate::thread::present_turn_error;
use crate::thread::transcript::MessageRole;
use ash_app_server_protocol::protocol::plugins::PluginPackageDto;
use ash_app_server_protocol::protocol::skills::SkillCompatibilityDto;
use ash_app_server_protocol::protocol::skills::SkillDto;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_app_server_protocol::protocol::skills::SkillListResult;
use ash_app_server_protocol::protocol::skills::SkillSourceKindDto;
use ash_app_server_protocol::protocol::slash_commands::{
    SlashCommandArgumentModeDto, SlashCommandDefinition,
};
use ash_protocol::ContentDigest;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillSourceId;
use ash_protocol::StableTurnError;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::path::PathBuf;

#[test]
fn tui_declares_the_host_authority_required_by_add_dir() {
    assert_eq!(
        crate::client_capabilities()
            .dir_permissions_host
            .map(|capability| capability.version),
        Some(1)
    );
}

#[test]
fn remote_dir_is_displayed_without_enabling_local_path_search() {
    let local_root = PathBuf::from("/local/export-root");
    let remote_root = PathBuf::from("/srv/project");
    let options = crate::TuiOptions::new("Remote")
        .with_dir_root(local_root.clone())
        .with_remote_dir(remote_root.clone());

    assert_eq!(options.display_dir_root, remote_root);
    assert_eq!(options.host_dir_root, local_root);
    assert_eq!(options.host_file_search_root, None);
    assert_eq!(options.app_server_process, crate::AppServerProcess::Remote);
}

#[test]
fn local_app_server_process_is_carried_into_the_startup_context() {
    let options = crate::TuiOptions::new("Local").with_app_server_process_id(42);

    assert_eq!(
        options.startup_context().app_server_process,
        crate::AppServerProcess::Local(42)
    );
}

#[test]
fn profile_root_selects_product_scoped_theme_documents() {
    let profile_root = PathBuf::from("/profile");
    let options = crate::TuiOptions::new("Keybindings").with_profile_root(&profile_root);

    assert_eq!(options.theme_root, Some(profile_root.join("ash-code")));
}

#[test]
fn local_host_notices_remain_available_across_tui_option_clones() {
    let (sender, receiver) = std::sync::mpsc::channel();
    let notices = crate::TuiNotices::new(receiver);
    let options = crate::TuiOptions::new("Notices").with_notices(notices.clone());
    sender.send("Update ready".into()).unwrap();

    assert_eq!(notices.try_recv().unwrap(), "Update ready");
    assert!(options.notices.is_some());
}

#[test]
fn completed_active_turn_only_updates_lifecycle_after_snapshot_mapping() {
    let turn_id = turn_id();
    let mut app = working_app();
    app.set_active_turn(turn_id.clone());
    let turn = Turn {
        turn_id: turn_id.clone(),
        status: TurnStatus::Completed,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: vec![
            ThreadItem::UserMessage {
                item_id: ItemId::new("item_1").unwrap(),
                turn_id: turn_id.clone(),
                text: "prompt".into(),
            },
            ThreadItem::AgentMessage {
                item_id: ItemId::new("item_2").unwrap(),
                turn_id,
                text: "complete response".into(),
            },
        ],
        plan: None,
        pending_interaction: None,
        error: None,
    };
    let thread = Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session_1").unwrap(),
        thread_id: ThreadId::new("thread_1").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ThreadStatus::Active,
        sequence: 3,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: vec![turn.clone()],
    };
    app.update(ThreadEvent::TranscriptSnapshotReceived(
        ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot::from_thread(
            &thread,
        ),
    ));

    apply_active_turn_snapshot(&mut app, &[turn]);

    assert_eq!(app.active_turn(), None);
    assert_eq!(app.status(), &Status::Ready);
    assert_eq!(app.messages().len(), 2);
    assert_eq!(app.messages().last().unwrap().role(), MessageRole::Agent);
    assert_eq!(app.messages().last().unwrap().text(), "complete response");
}

#[test]
fn completed_turn_advances_to_the_next_queued_turn() {
    let first_id = TurnId::new("turn_1").unwrap();
    let second_id = TurnId::new("turn_2").unwrap();
    let mut app = working_app();
    app.set_active_turn(first_id.clone());
    let turns = vec![
        Turn {
            turn_id: first_id.clone(),
            status: TurnStatus::Completed,
            kind: Default::default(),
            instructions: None,
            model: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
            items: vec![ThreadItem::AgentMessage {
                item_id: ItemId::new("item_first").unwrap(),
                turn_id: first_id,
                text: "first answer".into(),
            }],
            plan: None,
            pending_interaction: None,
            error: None,
        },
        Turn {
            turn_id: second_id.clone(),
            status: TurnStatus::Running,
            kind: Default::default(),
            instructions: None,
            model: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
            items: Vec::new(),
            plan: None,
            pending_interaction: None,
            error: None,
        },
    ];

    apply_active_turn_snapshot(&mut app, &turns);

    assert_eq!(app.active_turn(), Some(&second_id));
    assert_eq!(app.status(), &Status::Working);
}

#[test]
fn waiting_active_turn_remains_interruptible() {
    let turn_id = turn_id();
    let mut app = working_app();
    app.set_active_turn(turn_id.clone());
    let turn = Turn {
        turn_id,
        status: TurnStatus::WaitingForUserInput,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: None,
    };

    apply_active_turn_snapshot(&mut app, &[turn]);

    assert!(app.active_turn().is_some());
    assert_eq!(app.status(), &Status::WaitingForUserInput);
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(super::app::AppCommand::Thread(ThreadCommand::Interrupt))
    );
}

#[test]
fn resumed_active_turn_returns_from_waiting_to_working() {
    let turn_id = turn_id();
    let mut app = working_app();
    app.set_active_turn(turn_id.clone());
    let waiting_turn = Turn {
        turn_id: turn_id.clone(),
        status: TurnStatus::WaitingForUserInput,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: None,
    };
    apply_active_turn_snapshot(&mut app, &[waiting_turn]);

    let resumed_turn = Turn {
        turn_id,
        status: TurnStatus::Running,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: None,
    };
    apply_active_turn_snapshot(&mut app, &[resumed_turn]);

    assert_eq!(app.status(), &Status::Working);
}

#[test]
fn failed_turn_shows_one_concise_error_on_failure_and_resume() {
    let turn_id = turn_id();
    let mut app = working_app();
    app.set_active_turn(turn_id.clone());
    let turn = Turn {
        turn_id,
        status: TurnStatus::Failed,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::new(),
        plan: None,
        pending_interaction: None,
        error: Some(StableTurnError::model_invocation_failed()),
    };

    let thread = Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session_1").unwrap(),
        thread_id: ThreadId::new("thread_1").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ThreadStatus::Active,
        sequence: 3,
        usage: Default::default(),
        reference_cost: Default::default(),
        goal: None,
        turns: vec![turn.clone()],
    };
    let snapshot =
        ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot::from_thread(
            &thread,
        );
    app.update(ThreadEvent::TranscriptSnapshotReceived(snapshot.clone()));
    apply_active_turn_snapshot(&mut app, &[turn]);

    assert_eq!(app.status(), &Status::Error);
    assert_eq!(app.active_turn(), None);
    let messages: Vec<_> = app
        .messages()
        .into_iter()
        .filter(|message| message.role() == MessageRole::Error)
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text(), "Request failed. Try again.");

    let mut resumed = App::new();
    resumed.update(ThreadEvent::TranscriptSnapshotReceived(snapshot));
    let messages: Vec<_> = resumed
        .messages()
        .into_iter()
        .filter(|message| message.role() == MessageRole::Error)
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text(), "Request failed. Try again.");
}

#[test]
fn persistence_failure_explains_that_the_response_was_not_saved() {
    assert_eq!(
        present_turn_error(&StableTurnError::completion_persistence_failed()),
        "Ash generated a response but couldn't save it. Please try again."
    );
}

#[test]
fn server_slash_commands_become_the_tui_runtime_registry() {
    let registry = chat_input_catalog_snapshot(
        &[SlashCommandDefinition {
            name: "diagnose".into(),
            description: "inspect the current dir".into(),
            argument_mode: SlashCommandArgumentModeDto::Optional,
            argument_hint: None,
        }],
        &empty_skill_catalog(),
        &[],
    )
    .unwrap();

    assert!(
        registry
            .slash_commands()
            .command_named("diagnose")
            .is_some()
    );
}

#[test]
fn server_slash_commands_cannot_shadow_local_builtins() {
    let Err(error) = chat_input_catalog_snapshot(
        &[SlashCommandDefinition {
            name: "quit".into(),
            description: "replace local quit".into(),
            argument_mode: SlashCommandArgumentModeDto::None,
            argument_hint: None,
        }],
        &empty_skill_catalog(),
        &[],
    ) else {
        panic!("server slash commands must not shadow local built-ins");
    };

    assert!(matches!(
        error,
        ash_app_server_client::ClientError::Protocol(message)
            if message.contains("duplicate slash command name 'quit'")
    ));
}

#[test]
fn enabled_unique_skills_become_dollar_selector_items() {
    let skill_id = SkillId::new(
        SkillSourceId::new("user:skill-source:test").unwrap(),
        SkillName::new("commit").unwrap(),
    );
    let digest = ContentDigest::sha256(b"commit skill");
    let registry = crate::thread::composer::chat_input_catalog_snapshot(
        &[SlashCommandDefinition {
            name: "commit".into(),
            description: "run the commit product command".into(),
            argument_mode: SlashCommandArgumentModeDto::Optional,
            argument_hint: None,
        }],
        &SkillListResult {
            generation: 1,
            skills: vec![SkillDto {
                id: skill_id.clone(),
                description: "draft a commit message".into(),
                source_kind: SkillSourceKindDto::User,
                content_digest: digest.clone(),
                enablement: SkillEnablementDto::Enabled,
                compatibility: SkillCompatibilityDto::Compatible,
            }],
            diagnostics: vec![],
        },
        &[],
    )
    .unwrap();

    assert!(registry.slash_commands().command_named("commit").is_some());
    assert_eq!(registry.skills().len(), 1);
    assert_eq!(registry.skills()[0].name(), "commit");
    assert_eq!(
        registry.skills()[0].skill(),
        &ash_protocol::SkillRef::pinned(skill_id, digest)
    );
}

#[test]
fn effective_plugins_become_at_mention_items() {
    let plugin = |id: &str, effective: bool| PluginPackageDto {
        id: id.into(),
        version: "1.0.0".into(),
        digest: "sha256:test".into(),
        enabled: effective,
        granted: effective,
        effective,
        revoked: false,
    };
    let registry = chat_input_catalog_snapshot(
        &[],
        &empty_skill_catalog(),
        &[plugin("acme/review", true), plugin("acme/disabled", false)],
    )
    .unwrap();

    assert_eq!(registry.plugins().len(), 1);
}

fn empty_skill_catalog() -> SkillListResult {
    SkillListResult {
        generation: 1,
        skills: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn working_app() -> App {
    let mut app = App::new();
    app.insert_text("prompt");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app
}

fn turn_id() -> TurnId {
    TurnId::new("turn_1").unwrap()
}
