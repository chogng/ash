use super::execute_product_command;
use crate::app::command_panel::CommandPanel;
use crate::app::{App, AppCommand, AppEvent, Status};
use crate::dirs::Command as DirCommand;
use crate::models::Command as ModelCommand;
use crate::sessions::ActiveConversation;
use crate::sessions::Command as SessionCommand;
use crate::sessions::ConversationChange;
use crate::sessions::ConversationTranscript;
use crate::skills::Command as SkillCommand;
use crate::skills::Event as SkillEvent;
use crate::thread::composer::{
    ChatInputItem, ChatSubmission, SlashCommandInvocation, TuiSlashCommandAction,
    built_in_catalog_command,
};
use crate::thread::read_thread;
use crate::thread::transcript::MessageRole;
use crate::thread::{ThreadRequestScope, submit_prompt};
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_client::{
    AppServerClient, InProcessClientOptions, InProcessTransport, start_in_process_client,
};
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::config::{ProviderConfigDto, ProviderConfigureParams};
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ReasoningEffort;
use ash_protocol::SessionStatus;
use ash_protocol::Thread;
use ash_protocol::ThreadStatus;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::fs;
use std::ops::Deref;
use std::ops::DerefMut;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn advisor_question_uses_consult_request_instead_of_worker_turn() {
    let (mut client, state_root, model) = client_with_model_probe();
    let conversation = ActiveConversation::start(&mut client, "advisor".into()).unwrap();
    let result = submit_prompt(
        &mut client,
        ThreadRequestScope::new(
            conversation.session_id(),
            conversation.thread_id(),
            conversation.thread_sequence(),
        ),
        ChatSubmission {
            display_text: "/advisor Check cancellation".into(),
            input: vec![ChatInputItem::Text("/advisor Check cancellation".into())],
        },
        ApprovalMode::AskPermissions,
    );
    let error = result.unwrap_err();
    assert!(error.to_string().contains("AdvisorDisabled"), "{error}");
    assert_eq!(model.calls(), 0);
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn branch_persists_lineage_switches_threads_and_does_not_call_the_model() {
    let (mut client, state_root, model) = client_with_model_probe();
    let mut conversation = ActiveConversation::start(&mut client, "original".into()).unwrap();
    let original_session = conversation.session_id().clone();
    let original_thread = conversation.thread_id().clone();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Branch, "investigation"),
        &mut app,
    );

    assert_eq!(conversation.session_id(), &original_session);
    assert_ne!(conversation.thread_id(), &original_thread);
    assert_eq!(app.status(), &Status::Ready);

    let forked_thread_id = conversation.thread_id().clone();
    let notice = app
        .messages()
        .last()
        .unwrap()
        .text()
        .replace(forked_thread_id.as_str(), "THREAD");
    insta::assert_snapshot!("branch_switch_notice", notice);
    let persisted_session = client
        .read_session(SessionReadParams {
            session_id: original_session.clone(),
        })
        .unwrap()
        .session;
    let forked_membership = persisted_session
        .threads
        .iter()
        .find(|thread| thread.thread_id == forked_thread_id)
        .unwrap();
    assert_eq!(forked_membership.status, ThreadStatus::Active);
    assert_eq!(forked_membership.parent_thread_id, None);
    assert_eq!(
        forked_membership.forked_from_id.as_ref(),
        Some(&original_thread)
    );
    let persisted_thread = client
        .read_session_thread(SessionThreadReadParams {
            session_id: original_session.clone(),
            thread_id: forked_thread_id,
            history: None,
        })
        .unwrap()
        .thread;
    assert_eq!(conversation.thread_sequence(), persisted_thread.sequence);
    assert!(persisted_thread.turns.is_empty());
    assert_eq!(model.calls(), 0);

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::New, "fresh task"),
        &mut app,
    );
    assert_ne!(conversation.session_id(), &original_session);
    assert_eq!(
        app.messages().last().unwrap().text(),
        "Started a new session."
    );

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Resume, original_session.as_str()),
        &mut app,
    );
    assert_eq!(conversation.session_id(), &original_session);
    assert_eq!(app.messages().last().unwrap().role(), MessageRole::Notice);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .text()
            .starts_with("Resumed session")
    );
    assert_eq!(model.calls(), 0);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn archive_persists_status_starts_a_new_session_and_does_not_call_the_model() {
    let (mut client, state_root, model) = client_with_model_probe();
    let mut conversation = ActiveConversation::start(&mut client, "archive me".into()).unwrap();
    let archived_session_id = conversation.session_id().clone();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Archive, ""),
        &mut app,
    );

    let archived = client
        .read_session(SessionReadParams {
            session_id: archived_session_id.clone(),
        })
        .unwrap()
        .session;
    assert_eq!(archived.status, SessionStatus::Archived);
    assert_ne!(conversation.session_id(), &archived_session_id);
    let next_session_id = conversation.session_id().clone();
    let next = client
        .read_session(SessionReadParams {
            session_id: next_session_id.clone(),
        })
        .unwrap()
        .session;
    assert_eq!(next.status, SessionStatus::Active);
    assert_eq!(
        app.messages().last().unwrap().text(),
        "Archived the previous session and started a new session."
    );
    assert_eq!(model.calls(), 0);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn status_mcp_connectors_and_skills_return_real_surfaces() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "commands".into()).unwrap();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Status, ""),
        &mut app,
    );
    assert!(matches!(app.command_panel(), Some(CommandPanel::Status(_))));
    assert!(app.overlay().is_none());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Mcp, ""),
        &mut app,
    );
    assert_eq!(app.list_selection().unwrap().title(), "MCP servers");
    assert!(app.list_selection().unwrap().search().is_some());
    app.update(AppEvent::CommandPanelClosed);

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Connectors, ""),
        &mut app,
    );
    assert_eq!(app.list_selection().unwrap().title(), "Connectors");
    assert!(app.list_selection().unwrap().search().is_some());
    app.update(AppEvent::CommandPanelClosed);

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Skills, ""),
        &mut app,
    );
    assert_eq!(app.status(), &Status::Ready);
    let selection = app.list_selection().unwrap();
    assert_eq!(selection.title(), "Skills");
    assert_eq!(selection.active_tab().label(), "All (2)");
    assert_eq!(
        selection
            .visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        vec!["create-instructions", "skill-creator"]
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn skills_view_toggles_catalog_entries_by_enablement() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "skills".into()).unwrap();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Skills, ""),
        &mut app,
    );

    let all = app.list_selection().unwrap();
    assert_eq!(all.active_tab().label(), "All (2)");
    assert_eq!(
        all.visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        vec!["create-instructions", "skill-creator"]
    );
    assert!(
        all.visible_items()
            .iter()
            .find(|item| item.label() == "skill-creator")
            .unwrap()
            .description()
            .unwrap()
            .contains("enabled  ·  built-in  ·  builtin:skill-source:ash-release")
    );

    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let enabled = app.list_selection().unwrap();
    assert_eq!(enabled.active_tab().label(), "Enabled (2)");
    assert_eq!(
        enabled
            .visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        vec!["create-instructions", "skill-creator"]
    );

    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let action = app
        .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    let AppCommand::Skills(SkillCommand::SetEnablement {
        skill_id,
        enablement,
    }) = action
    else {
        panic!("Enter should request a skill enablement change");
    };
    assert_eq!(skill_id.name.as_str(), "skill-creator");
    assert_eq!(enablement, SkillEnablementDto::Disabled);

    let view = crate::skills::set_enablement(
        &mut client,
        Some(&ash_protocol::SessionId::new("test-session").unwrap()),
        skill_id,
        enablement,
    )
    .unwrap();
    app.update(SkillEvent::SettingsUpdated(view));
    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE));
    let disabled = app.list_selection().unwrap();
    assert_eq!(disabled.active_tab().label(), "Disabled (1)");
    assert_eq!(disabled.visible_items()[0].label(), "skill-creator");

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn model_command_updates_and_clears_model_with_config_revision() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "model".into()).unwrap();
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(ProviderConfigureParams {
            command_id: CommandId::new("configure-test-provider").unwrap(),
            expected_revision: revision,
            config: ProviderConfigDto {
                custom: None,
                provider: "test".into(),
                base_url: None,
                max_output_tokens: None,
                model_context: Default::default(),
            },
        })
        .unwrap();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Model, "test/model-one"),
        &mut app,
    );

    let configured = client.read_config().unwrap();
    let selected = configured.model.unwrap();
    assert_eq!(selected.provider, "test");
    assert_eq!(selected.model, "model-one");
    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "model-one"
    );
    assert_eq!(
        app.status_line()
            .policy_text_for_width(80, app.approval_mode()),
        "⏸ ask permissions on"
    );

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Model, "clear"),
        &mut app,
    );
    assert_eq!(client.read_config().unwrap().model, None);
    assert_eq!(
        app.status_line()
            .policy_text_for_width(80, app.approval_mode()),
        "⏸ ask permissions on"
    );
    assert_eq!(app.status(), &Status::Ready);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn theme_selection_updates_the_tui_toml_section() {
    let (mut client, state_root) = client();

    crate::theme::set_preference(&mut client, "ash-code-light".into()).unwrap();

    assert_eq!(
        crate::theme::preference(&client.read_config().unwrap()),
        "ash-code-light"
    );
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn keybindings_and_status_line_are_persisted_in_the_tui_toml_section() {
    let (mut client, state_root) = client();
    let revision = client.read_config().unwrap().revision;

    crate::keymap_setup::set_keymap(
        &mut client,
        crate::keymap_setup::KeymapEdit {
            expected_revision: revision,
            command_id: "ashCode.action.copyLastResponse".into(),
            kind: crate::keymap_setup::KeymapEditKind::Set {
                key: "ctrl+y".into(),
                intent: crate::keymap_setup::KeymapEditIntent::AddAlternate,
            },
        },
    )
    .unwrap();
    let revision = client.read_config().unwrap().revision;
    crate::status::set_status_line(
        &mut client,
        crate::status::StatusLineEdit {
            expected_revision: revision,
            item: crate::status::StatusLineItem::GitChanges,
            enabled: false,
        },
    )
    .unwrap();

    let config = client.read_config().unwrap();
    assert_eq!(
        config.tui.0.get("keybindings"),
        Some(&serde_json::json!([{
            "key": "ctrl+y",
            "command": "ashCode.action.copyLastResponse"
        }]))
    );
    assert_eq!(
        config.tui.0.get("statusLine"),
        Some(&serde_json::json!(["permissions", "model", "git-branch"]))
    );
    assert_eq!(
        config.tui.0.get("showGitChangesAsDiff"),
        Some(&serde_json::json!(false))
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn show_git_changes_as_diff_is_persisted_in_the_tui_toml_section() {
    let (mut client, state_root) = client();
    let server_config = client.read_config().unwrap();
    let terminal = crate::config::TerminalSettings::from_tui(&server_config.tui).unwrap();
    let mut status_line = crate::status::StatusLineSettings::from_tui(&server_config.tui).unwrap();
    status_line.set_show_git_changes_as_diff(true);

    crate::config::set_settings(
        &mut client,
        crate::config::ConfigEdit {
            terminal,
            status_line,
            server_config,
            providers: ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
        },
    )
    .unwrap();

    assert_eq!(
        client
            .read_config()
            .unwrap()
            .tui
            .0
            .get("showGitChangesAsDiff"),
        Some(&serde_json::json!(true))
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn language_is_persisted_in_the_tui_toml_section() {
    let (mut client, state_root) = client();
    let server_config = client.read_config().unwrap();
    let mut terminal = crate::config::TerminalSettings::from_tui(&server_config.tui).unwrap();
    terminal.set_language(crate::nls::Language::Chinese);
    let status_line = crate::status::StatusLineSettings::from_tui(&server_config.tui).unwrap();

    crate::config::set_settings(
        &mut client,
        crate::config::ConfigEdit {
            terminal,
            status_line,
            server_config,
            providers: ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
        },
    )
    .unwrap();

    assert_eq!(
        client.read_config().unwrap().tui.0.get("language"),
        Some(&serde_json::json!("zh-CN"))
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn key_hint_style_is_persisted_in_the_tui_toml_section() {
    let (mut client, state_root) = client();
    let server_config = client.read_config().unwrap();
    let mut terminal = crate::config::TerminalSettings::from_tui(&server_config.tui).unwrap();
    terminal.set_key_hint_style(crate::config::KeyHintStyle::Muted);
    let status_line = crate::status::StatusLineSettings::from_tui(&server_config.tui).unwrap();

    crate::config::set_settings(
        &mut client,
        crate::config::ConfigEdit {
            terminal,
            status_line,
            server_config,
            providers: ash_app_server_protocol::protocol::provider::ProviderListResult {
                providers: Vec::new(),
            },
        },
    )
    .unwrap();

    assert_eq!(
        client.read_config().unwrap().tui.0.get("keyHintStyle"),
        Some(&serde_json::json!("muted"))
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn resume_and_model_without_arguments_open_actionable_pickers() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "current".into()).unwrap();
    let current_session = conversation.session_id().to_string();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Resume, ""),
        &mut app,
    );
    assert_eq!(app.list_selection().unwrap().title(), "Resume session");
    assert!(app.list_selection().unwrap().search().is_some());
    assert!(app.session_manager_view().is_none());
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Sessions(SessionCommand::Resume {
            session_id: current_session,
            preferred_thread_id: None,
        }))
    );
    app.update(AppEvent::CommandPanelClosed);

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Model, ""),
        &mut app,
    );
    assert_eq!(app.list_selection().unwrap().title(), "Model");
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Favorites"
    );
    assert!(app.list_selection().unwrap().visible_items().is_empty());
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .is_none()
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn rewind_without_arguments_opens_the_checkpoint_picker() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "rewind".into()).unwrap();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Rewind, ""),
        &mut app,
    );

    assert_eq!(app.list_selection().unwrap().title(), "Rewind");
    assert!(app.list_selection().unwrap().search().is_some());
    assert!(app.list_selection().unwrap().visible_items().is_empty());

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn add_dir_adds_lists_and_removes_the_exact_session_directory() {
    let _test_guard = dispatch_test_guard();
    let state_root = std::env::temp_dir().join(format!(
        "ash-tui-add-dir-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dir = state_root.join("dir");
    let additional = state_root.join("additional");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&additional).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "ash-tui-add-dir-test".into(),
                version: "1".into(),
            },
        )
        .with_capabilities(crate::client_capabilities())
        .with_dir_root(&dir)
        .with_model_operation_client(Arc::new(OfflineOperationClient::default())),
    )
    .unwrap();
    let mut conversation = ActiveConversation::start(&mut client, "add dir".into()).unwrap();
    let mut app = App::new();

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::AddDir, ""),
        &mut app,
    );
    assert!(app.list_selection().unwrap().visible_items().is_empty());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    let output = super::execute_product_command(
        Some(conversation),
        &mut client,
        &dir,
        invocation(
            TuiSlashCommandAction::AddDir,
            &additional.display().to_string(),
        ),
    )
    .unwrap();
    conversation = output
        .conversation
        .expect("an existing conversation remains selected");
    for event in output.events {
        app.update(event);
    }

    let repeated = execute_product_command(
        Some(conversation.clone()),
        &mut client,
        &dir,
        invocation(
            TuiSlashCommandAction::AddDir,
            &additional.display().to_string(),
        ),
    )
    .unwrap();
    assert!(repeated.conversation_change.is_none());
    assert_eq!(repeated.events.len(), 2);
    assert!(matches!(
        &repeated.events[0],
        AppEvent::Thread(crate::thread::Event::CommandStarted(command))
            if command == &format!("/add-dir {}", additional.display())
    ));
    assert!(matches!(
        &repeated.events[1],
        AppEvent::Thread(crate::thread::Event::CommandCompleted { command, result })
            if command == &format!("/add-dir {}", additional.display())
                && result == &format!("Directory already added: {}", additional.display())
    ));

    let listed = client
        .list_session_dirs(SessionDirListParams {
            session_id: conversation.session_id().clone(),
        })
        .unwrap();
    assert_eq!(listed.dirs.len(), 1);
    assert_eq!(
        listed.dirs[0].path.canonicalize().unwrap(),
        additional.canonicalize().unwrap()
    );
    assert_eq!(listed.dirs[0].permissions, Vec::<PermissionDto>::new());
    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::AddDir, ""),
        &mut app,
    );
    assert_eq!(app.list_selection().unwrap().title(), "Directories");
    let Some(AppCommand::Dirs(DirCommand::Remove { path })) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("the selected directory emits an exact remove command")
    };
    assert_eq!(
        path.canonicalize().unwrap(),
        additional.canonicalize().unwrap()
    );

    let event = crate::dirs::execute(
        &mut client,
        conversation.session_id(),
        DirCommand::Remove { path },
    )
    .unwrap();
    app.update(AppEvent::Dirs(event));
    assert!(app.list_selection().unwrap().visible_items().is_empty());
    assert!(
        client
            .list_session_dirs(SessionDirListParams {
                session_id: conversation.session_id().clone(),
            })
            .unwrap()
            .dirs
            .is_empty()
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn product_commands_reject_image_arguments_instead_of_silently_dropping_them() {
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "images".into()).unwrap();
    let mut app = App::new();
    let invocation = SlashCommandInvocation {
        command: built_in_catalog_command(TuiSlashCommandAction::Model),
        origin: ash_slash_commands::SlashCommandOrigin::Local,
        display_arguments: "[Image #1]".into(),
        arguments: vec![ChatInputItem::Image {
            url: "data:image/png;base64,cG5n".into(),
        }],
    };

    execute(&mut conversation, &mut client, invocation, &mut app);

    assert_eq!(app.status(), &Status::Error);
    assert_eq!(app.messages().last().unwrap().role(), MessageRole::Error);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .text()
            .contains("do not accept image arguments")
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

fn invocation(command: TuiSlashCommandAction, arguments: &str) -> SlashCommandInvocation {
    SlashCommandInvocation {
        command: built_in_catalog_command(command),
        origin: ash_slash_commands::SlashCommandOrigin::Local,
        display_arguments: arguments.into(),
        arguments: (!arguments.is_empty())
            .then(|| ChatInputItem::Text(arguments.into()))
            .into_iter()
            .collect(),
    }
}

fn client() -> (DispatchTestClient, PathBuf) {
    let (client, state_root, _) = client_with_model_probe();
    (client, state_root)
}

fn client_with_model_probe() -> (DispatchTestClient, PathBuf, Arc<OfflineOperationClient>) {
    let guard = dispatch_test_guard();
    static NEXT_STATE_ROOT: AtomicU64 = AtomicU64::new(1);
    let state_root = std::env::temp_dir().join(format!(
        "ash-tui-slash-dispatch-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_STATE_ROOT.fetch_add(1, Ordering::Relaxed)
    ));
    let model = Arc::new(OfflineOperationClient::default());
    let client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "ash-tui-test".into(),
                version: "1".into(),
            },
        )
        .with_model_operation_client(model.clone()),
    )
    .unwrap();
    (
        DispatchTestClient {
            client,
            _guard: guard,
        },
        state_root,
        model,
    )
}

fn dispatch_test_guard() -> MutexGuard<'static, ()> {
    crate::test_support::in_process_test_guard()
}

struct DispatchTestClient {
    client: AppServerClient<InProcessTransport>,
    _guard: MutexGuard<'static, ()>,
}

impl Deref for DispatchTestClient {
    type Target = AppServerClient<InProcessTransport>;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl DerefMut for DispatchTestClient {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.client
    }
}

#[derive(Default)]
struct OfflineOperationClient {
    calls: AtomicU64,
}

impl OfflineOperationClient {
    fn calls(&self) -> u64 {
        self.calls.load(Ordering::SeqCst)
    }
}

impl OperationClient for OfflineOperationClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ClientError::Transport(
            "model transport is disabled in TUI command tests".into(),
        ))
    }
}

#[test]
fn status_line_style_persists_and_rejects_stale_edits() {
    let (mut client, state_root) = client();
    let server_config = client.read_config().unwrap();
    let terminal = crate::config::TerminalSettings::from_tui(&server_config.tui).unwrap();
    let mut status_line = crate::status::StatusLineSettings::from_tui(&server_config.tui).unwrap();
    status_line.set_style(crate::status::StatusLineStyle::Rich);
    let edit = crate::config::ConfigEdit {
        terminal,
        status_line,
        server_config,
        providers: ash_app_server_protocol::protocol::provider::ProviderListResult {
            providers: vec![],
        },
    };
    let result = crate::config::set_settings(&mut client, edit.clone()).unwrap();
    assert_eq!(
        result.status_line.style(),
        crate::status::StatusLineStyle::Rich
    );
    assert!(crate::config::set_settings(&mut client, edit).is_err());
    let revision = client.read_config().unwrap().revision;
    crate::status::set_status_line(
        &mut client,
        crate::status::StatusLineEdit {
            expected_revision: revision,
            item: crate::status::StatusLineItem::Context,
            enabled: true,
        },
    )
    .unwrap();
    let saved = client.read_config().unwrap();
    assert_eq!(saved.tui.0["statusLineStyle"], serde_json::json!("rich"));
    assert!(
        crate::status::StatusLineSettings::from_tui(&saved.tui)
            .unwrap()
            .enabled(crate::status::StatusLineItem::Context)
    );
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn model_pins_keep_provider_identity_and_provider_deletion_cleans_preferences() {
    let (mut client, root, model) = client_with_model_probe();
    for id in ["custom-first", "custom-second"] {
        let revision = client.read_config().unwrap().revision;
        client.configure_provider(ProviderConfigureParams {
            command_id: CommandId::new(format!("configure-{id}")).unwrap(), expected_revision: revision,
            config: ProviderConfigDto {
                provider: id.into(), base_url: Some("https://example.invalid/v1".into()), max_output_tokens: None, model_context: Default::default(),
                custom: Some(ash_app_server_protocol::protocol::config::CustomProviderConfigDto {
                    context_window: 272_000, order: 0, name: id.into(), model: Some("shared-alias".into()),
                    protocol: ash_app_server_protocol::protocol::config::CustomProviderProtocolDto::Responses,
                }),
            },
        }).unwrap();
        crate::models::execute(
            &mut *client,
            ModelCommand::Pin {
                preference: format!("{id}/shared-alias"),
                pinned: true,
            },
        )
        .unwrap();
    }
    let config = client.read_config().unwrap();
    assert_eq!(config.tui.0["pinnedModels"].as_array().unwrap().len(), 2);
    let choices = crate::models::load_selection(&mut *client).unwrap();
    let state = crate::widgets::list_selection::ListSelectionState::new(choices.model);
    assert_eq!(state.active_tab().label(), "Favorites");
    assert_eq!(state.visible_items().len(), 2);
    assert_eq!(state.tabs()[1].label(), "custom-second");
    crate::models::execute(
        &mut *client,
        ModelCommand::Pin {
            preference: "custom-first/shared-alias".into(),
            pinned: false,
        },
    )
    .unwrap();
    let config = client.read_config().unwrap();
    crate::config::execute(
        &mut *client,
        crate::config::Command::Connection(crate::config::provider::Request {
            id: CommandId::new("delete-pinned-provider").unwrap(),
            revision: config.revision,
            config: config.providers["custom-second"].clone(),
            key: None,
            model: None,
            operation: crate::config::provider::Operation::Remove,
        }),
    )
    .unwrap();
    let config = client.read_config().unwrap();
    assert_eq!(config.tui.0["pinnedModels"], serde_json::json!([]));
    assert!(!config.providers.contains_key("custom-second"));
    assert_eq!(
        model.calls(),
        0,
        "listing and pinning custom models never fetches remote models"
    );
    drop(client);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn custom_model_picker_replaces_inherited_ids_with_the_configured_id() {
    let (mut client, root, transport) = client_with_model_probe();
    let mut config = ProviderConfigDto {
        provider: "custom-gateway".into(),
        base_url: Some("https://example.invalid/v1".into()),
        max_output_tokens: None,
        model_context: Default::default(),
        custom: Some(
            ash_app_server_protocol::protocol::config::CustomProviderConfigDto {
                context_window: 272_000,
                order: 0,
                model: None,
                name: "Gateway".into(),
                protocol:
                    ash_app_server_protocol::protocol::config::CustomProviderProtocolDto::Responses,
            },
        ),
    };
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(ProviderConfigureParams {
            command_id: CommandId::new("create-gateway").unwrap(),
            expected_revision: revision,
            config: config.clone(),
        })
        .unwrap();
    assert!(
        client
            .list_models()
            .unwrap()
            .models
            .iter()
            .any(|entry| entry.model.provider.as_str() == "custom-gateway"
                && entry.model.model.as_str() == "gpt-5.6")
    );
    crate::models::set_model(&mut *client, "custom-gateway/gpt-5.6").unwrap();
    config.custom.as_mut().unwrap().model = Some("private-alias".into());
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(ProviderConfigureParams {
            command_id: CommandId::new("change-gateway-model").unwrap(),
            expected_revision: revision,
            config,
        })
        .unwrap();
    let catalog = client.list_models().unwrap();
    let models = catalog
        .models
        .iter()
        .filter(|entry| entry.model.provider.as_str() == "custom-gateway")
        .map(|entry| entry.model.model.as_str())
        .collect::<Vec<_>>();
    assert_eq!(models, vec!["private-alias"]);
    assert_eq!(transport.calls(), 0);
    drop(client);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn set_model_sets_and_clears_model_reasoning_effort() {
    let (mut client, root, transport) = client_with_model_probe();
    let config = ProviderConfigDto {
        provider: "openai".into(),
        base_url: None,
        max_output_tokens: None,
        model_context: Default::default(),
        custom: None,
    };
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(ProviderConfigureParams {
            command_id: CommandId::new("create-openai").unwrap(),
            expected_revision: revision,
            config,
        })
        .unwrap();

    // Specifying valid effort on a model that supports it
    let update = crate::models::set_model(&mut *client, "openai/gpt-6-astra high").unwrap();
    crate::tui_assert_snapshot!(&update.notice, @"Model: openai/gpt-6-astra (high)");
    assert_eq!(
        update.summary.model_reasoning_effort(),
        Some(ReasoningEffort::High)
    );
    let read = client.read_config().unwrap();
    assert_eq!(read.model_reasoning_effort, Some(ReasoningEffort::High));

    // Unsupported model fails
    let err = crate::models::set_model(&mut *client, "openai/gpt-5.6 high").unwrap_err();
    assert!(
        err.to_string()
            .contains("does not support reasoning effort")
    );

    // Invalid effort fails
    let err = crate::models::set_model(&mut *client, "openai/gpt-6-astra super").unwrap_err();
    assert!(err.to_string().contains("invalid reasoning effort"));

    // Setting model without effort clears model reasoning effort.
    let update = crate::models::set_model(&mut *client, "openai/gpt-6-astra").unwrap();
    assert_eq!(update.notice, "Model: openai/gpt-6-astra");
    assert_eq!(update.summary.model_reasoning_effort(), None);
    let read = client.read_config().unwrap();
    assert_eq!(read.model_reasoning_effort, None);

    // Clear unsets model and effort
    let update = crate::models::set_model(&mut *client, "clear").unwrap();
    assert_eq!(update.notice, "Model: not configured");
    assert_eq!(update.summary.model(), None);
    assert_eq!(update.summary.model_reasoning_effort(), None);

    // Clear with extra argument fails
    let err = crate::models::set_model(&mut *client, "clear now").unwrap_err();
    assert!(
        err.to_string()
            .contains("does not accept additional arguments")
    );

    assert_eq!(transport.calls(), 0);
    drop(client);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cd_moves_the_active_session_to_a_new_working_directory() {
    let _test_guard = dispatch_test_guard();
    let state_root = std::env::temp_dir().join(format!(
        "ash-tui-cd-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dir = state_root.join("dir");
    let next_dir = state_root.join("next_dir");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&next_dir).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "ash-tui-cd-test".into(),
                version: "1".into(),
            },
        )
        .with_capabilities(crate::client_capabilities())
        .with_dir_root(&dir)
        .with_model_operation_client(Arc::new(OfflineOperationClient::default())),
    )
    .unwrap();
    let mut conversation = ActiveConversation::start(&mut client, "cd test".into()).unwrap();
    let mut app = App::for_dir(&dir);

    execute(
        &mut conversation,
        &mut client,
        invocation(TuiSlashCommandAction::Cd, &next_dir.display().to_string()),
        &mut app,
    );
    assert_eq!(
        app.startup_context().workspace,
        next_dir.canonicalize().unwrap()
    );
    assert_eq!(
        app.welcome().directory(),
        next_dir.canonicalize().unwrap().display().to_string()
    );
    let _ = fs::remove_dir_all(state_root);
}

fn execute<T>(
    conversation: &mut ActiveConversation,
    client: &mut AppServerClient<T>,
    invocation: SlashCommandInvocation,
    app: &mut App,
) where
    T: JsonRpcTransport,
{
    match execute_product_command(
        Some(conversation.clone()),
        client,
        &app.startup_context().workspace,
        invocation,
    ) {
        Ok(output) => {
            *conversation = output
                .conversation
                .expect("an existing conversation remains selected");
            for event in output.events {
                app.update(event);
            }
            if let Some(change) = output.conversation_change {
                match read_thread(client, conversation.session_id(), conversation.thread_id()) {
                    Ok(snapshot) => apply_conversation_change(app, change, snapshot),
                    Err(error) => {
                        app.update(crate::thread::Event::FailureReported(error.to_string()))
                    }
                }
            }
        }
        Err(error) => app.update(crate::thread::Event::FailureReported(error)),
    }
}

fn apply_conversation_change(app: &mut App, change: ConversationChange, snapshot: Thread) {
    if matches!(change.transcript, ConversationTranscript::Clear) {
        app.update(crate::thread::Event::TranscriptCleared);
    }
    app.update(crate::thread::Event::TranscriptSnapshotReceived(
        ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot::from_thread(
            &snapshot,
        ),
    ));
    app.update(crate::thread::Event::ProductNotice(change.notice));
}
