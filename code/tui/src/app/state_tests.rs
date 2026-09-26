use super::App;
use super::AppCommand;
use super::Status;
use crate::app::AppEvent;
use crate::config::Command as ConfigCommand;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::config::advisor_choices;
use crate::config::config_choices;
use crate::dirs::Command as DirCommand;
use crate::host::Command as HostCommand;
use crate::host::Event as HostEvent;
use crate::host::clipboard::ClipboardImage;
use crate::host::clipboard::ClipboardImageFingerprint;
use crate::keymap_setup::Command as KeymapCommand;
use crate::keymap_setup::Event as KeymapEvent;
use crate::keymap_setup::KeymapEditIntent;
use crate::keymap_setup::KeymapEditKind;
use crate::keymap_setup::KeymapEditorUpdate;
use crate::keymap_setup::keymap_choices;
use crate::keymap_setup::settings_from_tui as keymap_settings_from_tui;
use crate::nls::Language;
use crate::render::RenderTheme;
use crate::sessions::Command as SessionCommand;
use crate::sessions::Event as SessionEvent;
use crate::skills::Event as SkillEvent;
use crate::status::Command as StatusCommand;
use crate::status::Event as StatusEvent;
use crate::status::ProcessMemoryCurrent;
use crate::status::StatusLineEditorUpdate;
use crate::status::StatusLineItem;
use crate::status::StatusLineSettings;
use crate::status::StatusViewData;
use crate::status::status_line_choices;
use crate::status::status_panel;
use crate::terminal::MouseMode;
use crate::test_support::empty_config_snapshot;
use crate::theme::Command as ThemeCommand;
use crate::theme::Event as ThemeEvent;
use crate::theme::ThemePickerCatalog;
use crate::theme::ThemePickerChoice;
use crate::theme::ThemePickerTarget;
use crate::theme::ThemePreviewPalette;
use crate::theme::custom_theme_choices;
use crate::theme::theme_choices;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::TurnActivity;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::ChatInputMode;
use crate::thread::composer::ChatSubmission;
use crate::thread::composer::CompletionView;
use crate::thread::composer::built_in_slash_command_definitions;
use crate::thread::composer::file_search::FileSearchManager;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::approval::ApprovalSpec;
use crate::thread::interaction::query::Query;
use crate::thread::interaction::query::QueryChoice;
use crate::thread::interaction::query::QueryCustomAnswer;
use crate::thread::interaction::query::QueryQuestion;
use crate::thread::rewind::rewind_choices;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::MessageRole;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirDto;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use ash_app_server_protocol::protocol::provider::{
    ProviderApiKeyPolicyDto, ProviderCatalogEntryDto, ProviderListResult,
};
use ash_app_server_protocol::protocol::skills::{SkillDiagnosticCodeDto, SkillDiagnosticDto};
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceUsage;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_protocol::ApprovalMode;
use ash_protocol::ContentDigest;
use ash_protocol::ItemId;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_terminal_detection::ColorLevel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::layout::Rect;
use ratatui::style::Color;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn skill_diagnostics_are_notices_and_are_suppressed_until_they_clear() {
    let mut app = App::new();
    let diagnostic = SkillDiagnosticDto {
        source: "user:skill-source:personal".into(),
        subject: Some("broken/SKILL.md".into()),
        code: SkillDiagnosticCodeDto::InvalidFrontmatter,
        message: "frontmatter is invalid".into(),
    };

    app.update(SkillEvent::DiagnosticsReceived(vec![diagnostic.clone()]));
    assert_eq!(app.messages().len(), 2);
    assert!(
        app.messages()
            .iter()
            .all(|message| message.role() == MessageRole::Notice)
    );
    assert_eq!(
        app.messages()[1].text(),
        "broken/SKILL.md: frontmatter is invalid"
    );

    app.update(SkillEvent::DiagnosticsReceived(vec![diagnostic.clone()]));
    assert_eq!(app.messages().len(), 2);

    app.update(SkillEvent::DiagnosticsReceived(Vec::new()));
    app.update(SkillEvent::DiagnosticsReceived(vec![diagnostic]));
    assert_eq!(app.messages().len(), 4);
}

fn config_session() -> SessionId {
    SessionId::new("config-state-session").unwrap()
}

fn enter_test_session(app: &mut App) {
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new("test-session").unwrap(),
        thread_id: ThreadId::new("test-thread").unwrap(),
    });
}
use ash_slash_commands::{
    SlashCommandArgumentMode, SlashCommandCatalog, SlashCommandDefinition, SlashCommandOrigin,
};

fn app_with_advisor_command() -> App {
    let catalog = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        [SlashCommandCatalog::default()
            .command_named("advisor")
            .unwrap()
            .clone()],
    )
    .unwrap();
    let mut app = App::new();
    app.replace_chat_input_catalog(crate::thread::composer::ChatInputCatalog::new(
        catalog,
        Vec::new(),
        Vec::new(),
    ));
    app
}

#[test]
fn enter_submits_trimmed_input_and_records_the_user_message() {
    let mut app = App::new();
    app.insert_text("  explain this  ");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, "explain this");
    assert_eq!(app.input(), "");
    assert_eq!(app.messages().len(), 1);
    assert_eq!(app.messages()[0].role(), MessageRole::User);
    assert_eq!(app.messages()[0].text(), "explain this");
    assert_eq!(app.status(), &Status::Working);
}

#[test]
fn blank_input_does_not_start_a_turn() {
    let mut app = App::new();
    app.insert_text("   ");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert!(app.messages().is_empty());
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn approval_preserves_the_hidden_draft_and_stays_open_after_submission_failure() {
    let mut app = App::new();
    enter_test_session(&mut app);
    app.insert_text("draft");
    app.update(ThreadEvent::ApprovalRequested(Approval::new(
        ApprovalSpec {
            title: "Approval required".into(),
            reason: "Run tests".into(),
            details: Vec::new(),
        },
    )));

    app.handle_paste("ignored".into());
    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected an Approval response");
    };
    let request = response.identity();
    app.update(ThreadEvent::RequestSubmissionFailed {
        request,
        error: "offline".into(),
    });

    assert_eq!(app.input(), "draft");
    assert_eq!(
        app.approval_view().and_then(|view| view.error),
        Some("offline")
    );
}

#[test]
fn query_paste_uses_its_own_editor_without_changing_the_chat_draft() {
    let mut app = App::new();
    enter_test_session(&mut app);
    app.insert_text("draft");
    app.update(ThreadEvent::QueryRequested(
        Query::new(vec![QueryQuestion {
            id: "answer".into(),
            header: "Answer".into(),
            prompt: "What next?".into(),
            choices: vec![QueryChoice {
                label: "Default".into(),
                description: "Use the default".into(),
            }],
            custom_answer: QueryCustomAnswer::Allowed,
        }])
        .unwrap(),
    ));

    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_paste("custom".into());

    assert_eq!(app.input(), "draft");
    assert_eq!(
        app.query_view().and_then(|view| view.custom_answer),
        Some("custom")
    );
}

#[test]
fn selected_theme_closes_the_theme_picker_immediately() {
    let mut app = App::new();
    app.update(ThemeEvent::PickerOpened(theme_choices(&theme_catalog())));

    assert_eq!(app.list_selection().unwrap().title(), "Theme");
    let command = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(
        command,
        Some(AppCommand::Theme(ThemeCommand::Set {
            preference: "ash-code-dark".into(),
        }))
    );
    assert!(app.list_selection().is_none());
}

#[test]
fn selected_render_theme_is_read_through_the_frame_context() {
    let mut app = App::new();
    let theme =
        RenderTheme::from_palette(crate::render::ThemePalette::light(), ColorLevel::TrueColor);

    app.update(ThemeEvent::RenderChanged(theme));

    assert_eq!(app.render_context().background(), Color::Rgb(255, 255, 255));
}

#[test]
fn keyboard_activation_uses_the_feature_action_mapping() {
    let mut app = App::new();
    app.update(ThemeEvent::PickerOpened(theme_choices(&theme_catalog())));

    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Theme(ThemeCommand::OpenCustomPicker))
    );
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
}

#[test]
fn selected_custom_theme_closes_the_entire_theme_flow_immediately() {
    let catalog = theme_catalog();
    let mut app = App::new();
    app.update(ThemeEvent::PickerOpened(theme_choices(&catalog)));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Theme(ThemeCommand::OpenCustomPicker))
    );
    app.update(ThemeEvent::PickerOpened(custom_theme_choices(&catalog)));
    let command = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(
        command,
        Some(AppCommand::Theme(ThemeCommand::SetCustom {
            preference: "aurora".into(),
        }))
    );
    assert!(app.list_selection().is_none());
}

#[test]
fn selected_rewind_checkpoint_emits_a_typed_rewind_action() {
    let turn_id = TurnId::new("turn-1").unwrap();
    let thread = Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "thread".into(),
        status: ThreadStatus::Active,
        sequence: 5,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: vec![Turn {
            advisor: None,
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
            items: vec![ThreadItem::UserMessage {
                item_id: ItemId::new("item-1").unwrap(),
                turn_id: turn_id.clone(),
                text: "restore here".into(),
            }],
            plan: None,
            pending_interaction: None,
            error: None,
        }],
    };
    let mut app = App::new();
    app.update(ThreadEvent::RewindPickerOpened(rewind_choices(
        &thread,
        &[],
    )));

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Thread(ThreadCommand::RewindToCheckpoint {
            before_turn_id: turn_id,
            checkpoint_label: "restore here".into(),
        }))
    );
    let point = ash_protocol::MessageCheckpoint {
        item_id: ItemId::new("item-1").unwrap(),
        turn_id: thread.turns[0].turn_id.clone(),
        source_thread_id: thread.thread_id.clone(),
        source_sequence: 3,
        after_sequence: 3,
        workspace: ash_protocol::WorkspaceCheckpoint::NoFiles,
    };
    app.update(ThreadEvent::RewindPickerOpened(rewind_choices(
        &thread,
        &[point],
    )));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Thread(ThreadCommand::RestoreMessage {
            item_id: ItemId::new("item-1").unwrap(),
            boundary: ash_protocol::MessageBoundary::After,
            checkpoint_label: "user: restore here".into(),
        }))
    );
}

fn theme_catalog() -> ThemePickerCatalog {
    ThemePickerCatalog {
        choices: vec![
            ThemePickerChoice {
                label: "Dark mode".into(),
                palette_label: "GitHub Dark".into(),
                target: ThemePickerTarget::Preference("ash-code-dark".into()),
                palette: theme_palette(),
                selected: true,
            },
            ThemePickerChoice {
                label: "Custom color theme".into(),
                palette_label: "User-defined".into(),
                target: ThemePickerTarget::CustomThemes,
                palette: theme_palette(),
                selected: false,
            },
        ],
        custom_choices: vec![ThemePickerChoice {
            label: "Aurora".into(),
            palette_label: "User-defined · Aurora".into(),
            target: ThemePickerTarget::Preference("aurora".into()),
            palette: theme_palette(),
            selected: false,
        }],
    }
}

fn theme_palette() -> ThemePreviewPalette {
    ThemePreviewPalette {
        background: Color::Black,
        border: Color::Gray,
        foreground: Color::White,
        muted: Color::DarkGray,
        focus: Color::Magenta,
        selection_foreground: Color::Magenta,
        keyword: Color::Red,
        string: Color::Blue,
        function: Color::Magenta,
        r#type: Color::Cyan,
        variable: Color::Yellow,
        inserted_background: Color::Green,
        removed_background: Color::Red,
        inserted_marker: Color::LightGreen,
        removed_marker: Color::LightRed,
    }
}

#[test]
fn large_paste_uses_a_placeholder_and_expands_on_submit() {
    let mut app = App::new();
    let pasted = "你".repeat(1001);

    app.handle_paste(pasted.clone());

    assert_eq!(app.input(), "[Pasted Content 1001 chars]");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, &pasted);
    assert_eq!(app.messages()[0].text(), pasted);
    assert_eq!(app.input(), "");
}

#[test]
fn repeated_large_pastes_with_the_same_size_have_distinct_placeholders() {
    let mut app = App::new();
    let first = "a".repeat(1001);
    let second = "b".repeat(1001);

    app.handle_paste(first.clone());
    app.insert_text(" ");
    app.handle_paste(second.clone());

    assert_eq!(
        app.input(),
        "[Pasted Content 1001 chars] [Pasted Content 1001 chars] #2"
    );

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, &format!("{first} {second}"));
}

#[test]
fn deleting_a_large_paste_placeholder_discards_its_payload() {
    let mut app = App::new();
    app.handle_paste("a".repeat(1001));

    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));

    assert_eq!(app.input(), "");
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    assert!(app.messages().is_empty());
}

#[test]
fn editing_before_a_large_paste_keeps_its_payload_binding() {
    let mut app = App::new();
    let pasted = "p".repeat(1001);
    app.insert_text("xa");
    app.handle_paste(pasted.clone());
    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, &format!("a{pasted}"));
}

#[test]
fn pasted_image_path_submits_a_structured_image() {
    let path = std::env::temp_dir().join(format!(
        "ash-tui-app-image-{}-{}.png",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&path, b"\x89PNG\r\n\x1a\npayload").unwrap();
    let mut app = App::new();

    app.handle_paste(path.to_string_lossy().into_owned());

    assert_eq!(app.input(), "[Image #1] ");
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let Some(AppCommand::Thread(ThreadCommand::SubmitTurn { submission, .. })) = action else {
        panic!("expected image submission");
    };
    assert_eq!(submission.display_text, "[Image #1]");
    assert_eq!(submission.input.len(), 1);
    assert!(matches!(
        &submission.input[0],
        ChatInputItem::Image { url } if url.starts_with("data:image/png;base64,")
    ));
    assert_eq!(app.messages()[0].text(), "[Image #1]");
    let _ = fs::remove_file(path);
}

#[test]
fn control_v_requests_a_clipboard_image_read() {
    let mut app = App::new();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL));

    assert_eq!(
        action,
        Some(AppCommand::Host(HostCommand::ReadClipboardImage {
            target: app.draft_target()
        }))
    );
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn control_o_requests_copy_and_control_z_requests_suspend() {
    let mut app = App::new();

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL)),
        Some(AppCommand::Host(HostCommand::CopyLastResponse))
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL)),
        Some(AppCommand::Suspend)
    );
}

#[test]
fn export_slash_command_stays_in_the_terminal_host() {
    let mut app = App::new();
    app.insert_text("/export notes/conversation.md");
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Host(HostCommand::ExportTranscript {
            requested_path: Some(std::path::PathBuf::from("notes/conversation.md")),
        }))
    );
}

#[test]
fn export_rejects_image_arguments_before_host_io() {
    let mut app = App::new();
    app.insert_text("/export ");
    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert_eq!(app.status(), &Status::Ready);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .text()
            .contains("relative text path")
    );
}

#[test]
fn local_conversation_commands_do_not_replace_a_running_turn() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.insert_text("/new");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert_eq!(app.status(), &Status::Working);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .detail()
            .unwrap()
            .contains("is unavailable")
    );
}

#[test]
fn control_home_requests_an_older_history_page() {
    let mut app = App::new();

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)),
        Some(AppCommand::Thread(ThreadCommand::LoadOlderHistory))
    );
}

#[test]
fn page_up_at_loaded_start_anchors_the_view_and_requests_older_history() {
    let mut app = App::new();
    app.update(ThreadEvent::FailureReported("only loaded message".into()));

    assert_eq!(
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
            Rect::new(0, 0, 80, 24),
        ),
        Some(AppCommand::Thread(ThreadCommand::LoadOlderHistory))
    );
    assert!(app.transcript_scroll().anchor().is_some());
}

#[test]
fn submitting_after_manual_scroll_restores_follow_latest() {
    let mut app = App::new();
    for index in 0..20 {
        app.update(ThreadEvent::FailureReported(format!("failure {index}")));
    }
    assert!(crate::app::fullscreen::navigation::scroll_transcript(
        &mut app,
        crate::thread::transcript::TranscriptScrollDirection::Up,
        Rect::new(0, 0, 80, 20),
    ));
    assert!(app.transcript_scroll().anchor().is_some());

    app.insert_text("continue");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(app.transcript_scroll().anchor(), None);
}

#[test]
fn clipboard_png_submits_through_the_existing_attachment_path() {
    let mut app = App::new();
    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });

    assert_eq!(app.input(), "[Image #1] ");
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let Some(AppCommand::Thread(ThreadCommand::SubmitTurn { submission, .. })) = action else {
        panic!("expected image submission");
    };
    assert_eq!(submission.display_text, "[Image #1]");
    assert!(matches!(
        &submission.input[0],
        ChatInputItem::Image { url } if url.starts_with("data:image/png;base64,")
    ));
}

#[test]
fn active_turn_accepts_clipboard_images_for_a_follow_up() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL));

    assert_eq!(
        action,
        Some(AppCommand::Host(HostCommand::ReadClipboardImage {
            target: app.draft_target()
        }))
    );
    assert_eq!(app.input(), "");
}

#[test]
fn control_c_requests_quit() {
    let mut app = App::new();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert_eq!(action, Some(AppCommand::Quit));
}

#[test]
fn quit_slash_command_requests_quit_without_starting_a_turn() {
    let mut app = App::new();
    app.insert_text("/quit");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Quit));
    assert_eq!(app.status(), &Status::Ready);
    assert!(app.messages().is_empty());
}

#[test]
fn product_command_is_delegated_to_the_typed_dispatcher() {
    let mut app = App::new();
    app.insert_text("/status");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let Some(AppCommand::Thread(ThreadCommand::ExecuteProductCommand(invocation))) = action else {
        panic!("expected product command action");
    };
    assert_eq!(invocation.command.name, "status");
    assert_eq!(invocation.origin, SlashCommandOrigin::Local);
    assert!(invocation.arguments.is_empty());
    assert_eq!(app.status(), &Status::Ready);
    assert_eq!(app.messages().len(), 1);
    assert_eq!(app.messages()[0].role(), MessageRole::Command);
    assert_eq!(app.messages()[0].text(), "/status");
    assert_eq!(
        app.messages()[0].command_status(),
        Some(CommandStatus::Submitted)
    );
}

#[test]
fn shortcut_slash_command_is_owned_by_the_local_host() {
    let mut app = App::new();
    app.insert_text("/shortcuts");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Keymap(KeymapCommand::OpenEditor)));
    assert_eq!(app.messages()[0].text(), "/shortcuts");
}

#[test]
fn config_slash_command_is_owned_by_the_local_host() {
    let mut app = App::new();
    app.insert_text("/config");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Config(ConfigCommand::OpenEditor)));
    assert_eq!(app.messages()[0].text(), "/config");
}

#[test]
fn advisor_command_opens_config_without_starting_a_session() {
    let mut app = app_with_advisor_command();
    app.insert_text("/advisor");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Config(ConfigCommand::OpenAdvisor)));
    assert!(app.messages().is_empty());
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn advisor_question_uses_a_turn_submission() {
    let mut app = app_with_advisor_command();
    app.insert_text("/advisor Check cancellation");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, "/advisor Check cancellation");
}

#[test]
fn config_owns_the_advisor_model_picker() {
    let config = empty_config_snapshot();
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    for character in "Advisor".chars() {
        app.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(action, Some(AppCommand::Config(ConfigCommand::OpenAdvisor)));

    app.update(ConfigEvent::AdvisorOpened {
        root: config_choices(
            &config,
            &ProviderListResult { providers: vec![] },
            TerminalSettings::default(),
            StatusLineSettings::default(),
        ),
        advisor: advisor_choices(
            &config,
            &ash_app_server_protocol::protocol::model::ModelListResult { models: vec![] },
            Language::English,
        ),
    });
    assert_eq!(app.list_selection().unwrap().title(), "Advisor");
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..24)
        .map(|y| (0..80).map(|x| buffer[(x, y)].symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("config_advisor_settings", rendered);
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.list_selection().unwrap().title(), "Advisor model");
    assert!(app.list_selection().unwrap().visible_items().is_empty());
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
}

#[test]
fn startup_slash_command_opens_a_read_only_context_panel() {
    let mut app = App::new();
    app.insert_text("/startup");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert_eq!(
        app.list_selection().map(|selection| selection.title()),
        Some("Startup")
    );
    assert_eq!(
        app.command_panel_key_hints().map(|hints| hints.text()),
        Some("Esc to close")
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    assert!(app.command_panel().is_some());
}

#[test]
fn theme_slash_command_is_owned_by_the_tui_host() {
    let mut app = App::new();
    app.insert_text("/theme");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Theme(ThemeCommand::OpenPicker)));
}

#[test]
fn inline_theme_selection_requests_a_tui_config_edit() {
    let mut app = App::new();
    app.insert_text("/theme ash-code-light");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        action,
        Some(AppCommand::Theme(ThemeCommand::Set {
            preference: "ash-code-light".into(),
        }))
    );
}

#[test]
fn screen_mode_keyboard_toggle_emits_a_revision_bound_edit() {
    let mut config = empty_config_snapshot();
    config.revision = 7;
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));

    for _ in 0..7 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(AppCommand::Config(ConfigCommand::Edit(edit)))
            if edit.server_config.revision == 7
                && edit.terminal.screen_mode() == crate::terminal::ScreenMode::Inline
    ));
}

#[test]
fn config_vim_mode_toggles_on_enter() {
    let mut config = empty_config_snapshot();
    config.revision = 7;
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));

    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Edit(edit)))
            if edit.server_config.revision == 7
                && edit.terminal.input_mode() == ChatInputMode::Vim
    ));
}

#[test]
fn config_memory_diagnostics_toggles_on_enter() {
    let mut config = empty_config_snapshot();
    config.revision = 7;
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));
    for _ in 0..1 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }

    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Edit(edit)))
            if edit.server_config.revision == 7
                && edit.terminal.memory_diagnostics()
    ));
}

#[test]
fn config_show_git_changes_as_diff_toggles_on_enter() {
    let mut config = empty_config_snapshot();
    config.revision = 7;
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));
    for _ in 0..3 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }

    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Edit(edit)))
            if edit.status_line.show_git_changes_as_diff()
    ));
}

#[test]
fn config_language_change_emits_a_profile_setting_edit() {
    let mut config = empty_config_snapshot();
    config.revision = 7;
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &ProviderListResult { providers: vec![] },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));
    for _ in 0..4 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }

    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Edit(edit)))
            if edit.server_config.revision == 7
                && edit.terminal.language() == Language::Japanese
    ));
}

#[test]
fn saved_language_rebuilds_the_open_config_page() {
    let config = empty_config_snapshot();
    let providers = ProviderListResult { providers: vec![] };
    let mut app = App::new();
    app.update(ConfigEvent::EditorOpened(config_choices(
        &config,
        &providers,
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )));
    let mut terminal = TerminalSettings::default();
    terminal.set_language(Language::Chinese);

    app.update(ConfigEvent::Updated(crate::config::ConfigEditResult {
        terminal,
        status_line: StatusLineSettings::default(),
        choices: config_choices(&config, &providers, terminal, StatusLineSettings::default()),
    }));

    let selection = app.list_selection().unwrap();
    assert_eq!(selection.title(), "配置");
    assert_eq!(
        selection.visible_items()[4].description(),
        Some("切换界面语言 中文")
    );
}

#[test]
fn directory_permission_selection_emits_a_revision_bound_server_edit() {
    let directories = SessionDirListResult {
        revision: 3,
        dirs: vec![SessionDirDto {
            contributions: Default::default(),
            path: "/dir/shared".into(),
            permissions: vec![PermissionDto::ReadFiles, PermissionDto::WriteFiles],
        }],
    };
    let mut app = App::new();
    app.update(crate::dirs::Event::PickerOpened(crate::dirs::choices(
        &config_session(),
        directories,
    )));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(AppCommand::Dirs(DirCommand::SetPermissions(params)))
            if params.expected_revision == 3
                && params.permissions == vec![PermissionDto::WriteFiles]
    ));
}

fn enter_provider_row(app: &mut App, label: &str) -> Option<AppCommand> {
    let mut settings = TerminalSettings::default();
    settings.set_language(app.language());
    app.update(ConfigEvent::EditorOpened(config_choices(
        &empty_config_snapshot(),
        &ProviderListResult {
            providers: vec![
                ProviderCatalogEntryDto {
                    provider: "openai".into(),
                    display_name: "OpenAI".into(),
                    api_key_policy: ProviderApiKeyPolicyDto::Required,
                    api_key_configured: false,
                },
                ProviderCatalogEntryDto {
                    provider: "xai".into(),
                    display_name: "xAI".into(),
                    api_key_policy: ProviderApiKeyPolicyDto::Required,
                    api_key_configured: false,
                },
                ProviderCatalogEntryDto {
                    provider: "zai".into(),
                    display_name: "zAI".into(),
                    api_key_policy: ProviderApiKeyPolicyDto::Required,
                    api_key_configured: false,
                },
            ],
        },
        settings,
        StatusLineSettings::default(),
    )));
    for code in [KeyCode::Tab, KeyCode::Char('/')] {
        app.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
    }
    app.handle_paste(label.into());
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
}

#[test]
fn official_provider_uses_the_api_key_prompt_and_redacts_its_command() {
    let mut app = App::new();
    enter_provider_row(&mut app, "OpenAI");
    app.handle_paste("test-key".into());
    let Some(AppCommand::Config(ConfigCommand::SetProviderApiKey(request))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected key save");
    };
    assert!(!format!("{request:?}").contains("test-key"));
    assert_eq!(request.into_parts(), ("openai".into(), "test-key".into()));
}

#[test]
fn escape_cancels_key_edit_without_saving_and_returns_to_providers() {
    let mut app = App::new();
    enter_provider_row(&mut app, "OpenAI");
    app.handle_paste("test-key".into());
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Providers"
    );
}

#[test]
fn chatgpt_subscription_shows_fetched_models_in_chinese() {
    use crate::config::SubscriptionCommand;
    use crate::config::SubscriptionEvent;
    use crate::config::SubscriptionProvider;
    use ash_app_server_protocol::protocol::account::AccountDto;
    use ash_app_server_protocol::protocol::account::AccountReadResult;
    use ash_app_server_protocol::protocol::account::AccountStatusDto;
    use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
    use ash_protocol::ModelAccess;
    use ash_protocol::ModelId;
    use ash_protocol::ModelInfo;
    use ash_protocol::ModelOutputTransport;
    use ash_protocol::ModelRef;
    use ash_protocol::ProviderId;

    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_language(Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    enter_provider_row(&mut app, "ChatGPT");
    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-ash").unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), "GPT Ash");
    info.access = ModelAccess::Subscription;
    let account = AccountDto {
        provider: "chatgpt-subscription".into(),
        account_id: "account-1".into(),
        email: Some("person@example.com".into()),
        display_name: Some("ChatGPT".into()),
        organization: None,
        plan: Some("pro".into()),
        status: AccountStatusDto::Ready,
        credential_revision: 1,
    };
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::ChatGpt,
        SubscriptionEvent::Read {
            account: AccountReadResult {
                revision: 1,
                accounts: vec![account.clone()],
            },
            models: Some(Ok(vec![ModelCatalogEntry::from_info(
                model,
                &info,
                ModelOutputTransport::Unary,
            )])),
        },
    ));
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("模型"));
    assert!(screen.contains("GPT Ash"));
    assert!(!screen.contains("gpt-ash"));
    assert!(!screen.contains("OpenAI"));
    crate::tui_assert_snapshot!("chatgpt_subscription_models_chinese", screen);

    for revision in 2..=3 {
        app.update(ConfigEvent::Subscription(SubscriptionEvent::Updated(
            AccountReadResult {
                revision,
                accounts: vec![AccountDto {
                    credential_revision: revision,
                    ..account.clone()
                }],
            },
        )));
        let screen = crate::app::usage_tests::render(&app, 96, 24);
        assert!(screen.contains("GPT Ash"));
        assert!(!screen.contains("正在处理"));
        assert_eq!(app.refresh_subscription(), None);
    }

    app.update(ConfigEvent::Subscription(SubscriptionEvent::Updated(
        AccountReadResult {
            revision: 4,
            accounts: vec![AccountDto {
                account_id: "account-2".into(),
                ..account
            }],
        },
    )));
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("正在加载模型"));
    assert!(!screen.contains("GPT Ash"));
    assert_eq!(
        app.refresh_subscription(),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Read,
        )))
    );
}

#[test]
fn chatgpt_subscription_keeps_pending_login_across_navigation_and_cancels_by_id() {
    use crate::config::SubscriptionCommand;
    use crate::config::SubscriptionEvent;
    use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
    use ash_app_server_protocol::protocol::account::AccountReadResult;
    let mut app = App::new();
    assert_eq!(
        enter_provider_row(&mut app, "ChatGPT"),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Read
        )))
    );
    app.update(ConfigEvent::Subscription(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 1,
            accounts: vec![],
        },
        models: None,
    }));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignIn
        )))
    );
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.update(ConfigEvent::Subscription(SubscriptionEvent::Started {
        login: AccountLoginStartResult::DeviceCode {
            login_id: "login-1".into(),
            verification_url: "https://auth.openai.com/codex/device".into(),
            user_code: "ABCD-1234".into(),
        },
        browser_error: None,
    }));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Providers"
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Read
        )))
    );
    app.update(ConfigEvent::Subscription(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 1,
            accounts: vec![],
        },
        models: None,
    }));
    for _ in 0..3 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Cancel {
                login_id: "login-1".into()
            }
        )))
    );
    app.update(ConfigEvent::Subscription(SubscriptionEvent::Cancelled {
        login_id: "login-1".into(),
    }));
    for _ in 0..2 {
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    }
    app.update(ConfigEvent::Subscription(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 2,
            accounts: vec![],
        },
        models: None,
    }));
    assert!(app.command_panel().is_none());
}

#[test]
fn chatgpt_external_login_error_shows_codex_instructions_and_allows_retry() {
    use crate::config::SubscriptionCommand;
    use ash_app_server_client::AppServerClient;
    use ash_app_server_client::ClientError;
    use ash_app_server_client::JsonRpcTransport;
    struct ExpiredAccount;
    impl JsonRpcTransport for ExpiredAccount {
        fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
            let request: serde_json::Value = serde_json::from_str(request).unwrap();
            let mut response = serde_json::json!({"jsonrpc":"2.0","id":request["id"]});
            match request["method"].as_str().unwrap() {
                "account/read" => {
                    response["result"] = serde_json::json!({"revision":1,"accounts":[{
                        "provider":"chatgpt-subscription","accountId":"account-1","status":"reauthenticationRequired",
                        "email":null,"displayName":"ChatGPT","organization":null,"plan":"pro","credentialRevision":1
                    }]})
                }
                "account/login/start" => {
                    response["error"] = serde_json::json!({"code":-32030,
                    "message":"AccountExternalLoginRequired","data":{"kind":"AccountExternalLoginRequired"}})
                }
                method => panic!("unexpected method {method}"),
            }
            Ok(response.to_string())
        }
    }
    let mut client = AppServerClient::new(ExpiredAccount);
    let mut app = App::new();
    let Some(AppCommand::Config(command)) = enter_provider_row(&mut app, "ChatGPT") else {
        panic!("subscription must read the account");
    };
    app.update(crate::config::execute(&mut client, command).unwrap());
    let mut signin = None;
    for _ in 0..8 {
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        if app
            .list_selection()
            .unwrap()
            .selected_item()
            .is_some_and(|item| item.label() == "Sign in with ChatGPT")
        {
            signin = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
            break;
        }
    }
    assert_eq!(
        signin,
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignIn
        )))
    );
    app.update(
        crate::config::execute(
            &mut client,
            ConfigCommand::Subscription(
                crate::config::SubscriptionProvider::ChatGpt,
                SubscriptionCommand::SignIn,
            ),
        )
        .unwrap(),
    );
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("Sign in to ChatGPT in Codex, then reconnect here."));
    assert!(!screen.contains("Working…"));
    crate::tui_assert_snapshot!("chatgpt_external_login_required", screen);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            crate::config::SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignIn
        )))
    );
}

#[test]
fn statusline_slash_command_is_owned_by_the_local_host() {
    let mut app = App::new();
    app.insert_text("/statusline");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        action,
        Some(AppCommand::Status(StatusCommand::OpenLineEditor))
    );
    assert_eq!(app.messages()[0].text(), "/statusline");
}

#[test]
fn statusline_selection_emits_a_revision_bound_edit() {
    let settings = StatusLineSettings::default();
    let choices = status_line_choices(&settings, 7);
    let mut app = App::new();
    app.update(StatusEvent::LineEditorOpened(StatusLineEditorUpdate {
        settings,
        choices,
    }));

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(AppCommand::Status(StatusCommand::EditLine(edit)))
            if edit.expected_revision == 7
                && edit.item == StatusLineItem::Permissions
                && !edit.enabled
    ));
}

#[test]
fn statusline_accounting_follows_the_current_thread_context() {
    let mut app = App::new();
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::CacheHitRate, true);
    settings.set(StatusLineItem::ReferenceCost, true);
    settings.set(StatusLineItem::Permissions, false);
    settings.set(StatusLineItem::Model, false);
    settings.set(StatusLineItem::GitBranch, false);
    settings.set(StatusLineItem::GitChanges, false);
    app.update(StatusEvent::LineSettingsReceived(settings));
    let mut usage = ash_protocol::ModelUsageSummary::default();
    usage.model_invocations = 1;
    usage.input_tokens.reported = 2_000;
    usage.cached_input_tokens.reported = 500;
    app.update(ThreadEvent::AccountingChanged {
        usage,
        reference_cost: ash_protocol::ModelReferenceCostSummary {
            known_amounts: vec![ash_protocol::ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "1250000000".into(),
            }],
            complete: true,
        },
    });

    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "cache hit 25.0% · cost $0.00125"
    );

    app.update(ThreadEvent::ContextChanged {
        session_id: ash_protocol::SessionId::new("session-next").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread-next").unwrap(),
    });

    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        ""
    );
}

#[test]
fn process_resource_sample_updates_the_optional_statusline_items() {
    let mut app = App::new();
    let request = ProcessResourceRequest {
        revision: 1,
        cpu_cycle: 1,
        demand: ProcessResourceDemand::Detailed,
    };
    app.apply_process_resource_request(request);

    app.update(HostEvent::ProcessResourcesSampled(
        ProcessResourcesReading {
            request,
            current: Ok(ProcessResourceUsage {
                resident_bytes: Some(128 * 1024 * 1024),
                cpu_tenths_percent: Some(124),
            }),
            tree: None,
            sampled_at: Instant::now(),
        },
    ));
    assert_eq!(
        app.status_line_runtime().process_resources.memory,
        ProcessMemoryCurrent::Available(128 * 1024 * 1024)
    );

    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(
            item,
            matches!(item, StatusLineItem::Memory | StatusLineItem::Cpu),
        );
    }
    app.update(StatusEvent::LineSettingsReceived(settings));

    assert_eq!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime()),
        "memory 128.0 MiB · cpu 12.4%"
    );
}

#[test]
fn shortcut_capture_emits_a_revision_bound_edit() {
    for (input, expected) in [
        (
            KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL),
            "ctrl+y",
        ),
        (KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), "tab"),
        (
            KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
            "shift+tab",
        ),
    ] {
        let mut app = App::new();
        let settings = keymap_settings_from_tui(&Default::default()).unwrap();
        let choices = keymap_choices(settings.keymap.setup_actions(), &[], 7);
        app.update(KeymapEvent::EditorOpened(KeymapEditorUpdate {
            settings,
            choices,
            notice: None,
        }));

        assert_eq!(app.list_selection().unwrap().title(), "Keymap");
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            None
        );
        assert_eq!(app.list_selection().unwrap().title(), "Cycle approval mode");
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            None
        );
        assert!(app.list_selection().is_none());

        let edit = app.handle_key(input);
        assert_eq!(
            edit,
            Some(AppCommand::Keymap(KeymapCommand::Edit(
                crate::keymap_setup::KeymapEdit {
                    expected_revision: 7,
                    command_id: "ashCode.action.cycleApprovalMode".into(),
                    kind: KeymapEditKind::Set {
                        key: expected.into(),
                        intent: KeymapEditIntent::ReplaceUser,
                    },
                }
            )))
        );
    }
}

#[test]
fn inline_product_arguments_reach_the_typed_dispatcher() {
    let mut app = App::new();
    app.insert_text("/model provider/model");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let Some(AppCommand::Thread(ThreadCommand::ExecuteProductCommand(invocation))) = action else {
        panic!("expected product command action");
    };
    assert_eq!(invocation.command.name, "model");
    assert_eq!(invocation.origin, SlashCommandOrigin::Local);
    assert_eq!(invocation.display_arguments, "provider/model");
    assert_eq!(
        invocation.arguments,
        vec![ChatInputItem::Text("provider/model".into())]
    );
    assert_eq!(app.status(), &Status::Ready);
    assert_eq!(app.messages()[0].text(), "/model provider/model");
}

#[test]
fn runtime_command_registry_drives_popup_and_submission_consistently() {
    let dir = temporary_dir("dynamic-slash-command");
    let registry = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        [SlashCommandDefinition {
            name: "diagnose".into(),
            description: "inspect the current dir".into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: None,
        }],
    )
    .unwrap();
    let mut app = App::for_dir_with_slash_commands(&dir, registry);
    app.insert_text("/diag logs");
    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));

    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(app.input(), "/diagnose logs");
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::SubmitTurn {
            submission: ChatSubmission {
                display_text: "/diagnose logs".into(),
                input: vec![ChatInputItem::Text("/diagnose logs".into())],
            },
        }))
    );
    assert_eq!(app.status(), &Status::Working);
    assert_eq!(app.messages()[0].role(), MessageRole::User);
    assert_eq!(app.messages()[0].text(), "/diagnose logs");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn help_uses_the_runtime_command_catalog_and_descriptions() {
    let dir = temporary_dir("runtime-slash-help");
    let registry = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        [SlashCommandDefinition {
            name: "diagnose".into(),
            description: "inspect the current dir".into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: None,
        }],
    )
    .unwrap();
    let mut app = App::for_dir_with_slash_commands(&dir, registry);
    let settings = keymap_settings_from_tui(&FrontendConfigDto(BTreeMap::from([(
        "keybindings".into(),
        serde_json::json!([{
            "key": "ctrl+y",
            "command": "ashCode.action.copyLastResponse"
        }]),
    )])))
    .unwrap();
    app.update(KeymapEvent::SettingsReceived(settings));
    app.insert_text("/help");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert_eq!(app.status(), &Status::Ready);
    let selection = app.list_selection().unwrap();
    assert_eq!(selection.active_tab().label(), "Shortcuts");
    assert_eq!(
        selection
            .tabs()
            .iter()
            .map(ListSelectionGroup::label)
            .collect::<Vec<_>>(),
        vec!["Shortcuts", "Commands", "Custom commands"]
    );
    let shortcuts = selection.visible_items();
    assert!(shortcuts.iter().any(|item| item.label() == "Esc Esc"));
    assert!(!shortcuts.iter().any(|item| matches!(
        item.label(),
        "Tab" | "Home / End" | "PageUp / PageDown" | "Ctrl-Home / Ctrl-End"
    )));
    let custom = shortcuts
        .iter()
        .find(|item| item.label() == "ctrl+y")
        .expect("the active user shortcut is included in help");
    assert_eq!(custom.description(), Some("Copy last response · custom"));

    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let selection = app.list_selection().unwrap();
    assert_eq!(selection.active_tab().label(), "Commands");
    let commands = selection.visible_items();
    let status = commands
        .iter()
        .find(|item| item.label() == "/status")
        .expect("the local command is included in help");
    assert_eq!(
        status.description(),
        Some("show the active session, thread, and model")
    );
    assert!(commands.iter().all(|item| item.label() != "/diagnose"));

    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let selection = app.list_selection().unwrap();
    assert_eq!(selection.active_tab().label(), "Custom commands");
    let custom_commands = selection.visible_items();
    let diagnose = custom_commands
        .iter()
        .find(|item| item.label() == "/diagnose")
        .expect("the server command is included in custom commands");
    assert_eq!(diagnose.description(), Some("inspect the current dir"));
    assert!(custom_commands.iter().all(|item| item.label() != "/status"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn dollar_skill_selector_submits_exact_skill_ref_with_visible_intent() {
    let dir = temporary_dir("skill-selector");
    let skill = SkillRef::pinned(
        SkillId::new(
            SkillSourceId::new("user:skill-source:test").unwrap(),
            SkillName::new("commit").unwrap(),
        ),
        ContentDigest::sha256(b"commit skill"),
    );
    let registry = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        std::iter::empty(),
    )
    .unwrap();
    let mut app = App::for_dir_with_slash_commands(&dir, registry.clone());
    app.replace_chat_input_catalog(crate::thread::composer::ChatInputCatalog::new(
        registry,
        vec![crate::thread::composer::SkillCompletionItem::new(
            "commit".into(),
            "draft a commit message".into(),
            skill.clone(),
        )],
        Vec::new(),
    ));
    app.insert_text("$com");
    assert!(matches!(
        app.completion(),
        Some(CompletionView::Skill(view)) if view.items[0].name() == "commit"
    ));
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.insert_text("staged changes");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::SubmitTurn {
            submission: ChatSubmission {
                display_text: "$commit staged changes".into(),
                input: vec![
                    ChatInputItem::Skill { skill },
                    ChatInputItem::Text("$commit staged changes".into()),
                ],
            },
        }))
    );
    assert_eq!(app.messages()[0].text(), "$commit staged changes");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn activating_a_slash_command_by_index_uses_the_command_dispatch_path() {
    let mut app = App::new();
    app.insert_text("/q");

    let action = app.activate_input_completion(0);

    assert_eq!(action, Some(AppCommand::Quit));
    assert!(app.input().is_empty());
    assert!(app.messages().is_empty());
}

#[test]
fn unknown_slash_input_remains_a_prompt() {
    let mut app = App::new();
    app.insert_text("/explain");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, "/explain");
    assert_eq!(app.status(), &Status::Working);
    assert_eq!(app.messages()[0].text(), "/explain");
}

#[test]
fn slash_popup_selection_executes_without_an_exact_query() {
    let mut app = App::new();
    app.insert_text("/q");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(action, Some(AppCommand::Quit));
    assert!(app.input().is_empty());
    assert!(app.messages().is_empty());
}

#[test]
fn weak_slash_popup_does_not_execute_a_command_without_selection() {
    let mut app = App::new();
    app.insert_text("/cofig");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_text_submission(action, "/cofig");
    assert_eq!(app.messages()[0].text(), "/cofig");
}

#[test]
fn enhanced_mouse_capture_covers_the_full_screen() {
    let mut app = App::new();
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);

    app.insert_text("/");
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);

    let dir = temporary_dir("mouse-interaction-mention");
    fs::write(dir.join("notes.md"), "notes").unwrap();
    let mut app = App::for_dir(&dir);
    app.insert_text("@notes");
    wait_for_mention_results(&mut app, &dir);

    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn fixed_requests_do_not_capture_mouse_for_a_hidden_completion() {
    for approval in [true, false] {
        let mut app = App::new();
        enter_test_session(&mut app);
        app.insert_text("/");
        assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
        if approval {
            app.update(ThreadEvent::ApprovalRequested(Approval::new(
                ApprovalSpec {
                    title: "Approval required".into(),
                    reason: "Run tests".into(),
                    details: Vec::new(),
                },
            )));
            assert!(app.approval_view().is_some());
        } else {
            app.update(ThreadEvent::QueryRequested(
                Query::new(vec![QueryQuestion {
                    id: "answer".into(),
                    header: "Answer".into(),
                    prompt: "What next?".into(),
                    choices: vec![QueryChoice {
                        label: "Default".into(),
                        description: "Use the default".into(),
                    }],
                    custom_answer: QueryCustomAnswer::Allowed,
                }])
                .unwrap(),
            ));
            assert!(app.query_view().is_some());
        }
        assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
        let area = Rect::new(0, 0, 80, 24);
        let mut request_targets = 0;
        for row in 0..area.height {
            for column in 0..area.width {
                match crate::app::fullscreen::pointer::target_at(&app, area, column, row) {
                    Some(crate::app::fullscreen::pointer::PointerTarget::Approval(_))
                        if approval =>
                    {
                        request_targets += 1
                    }
                    Some(crate::app::fullscreen::pointer::PointerTarget::Query(_)) if !approval => {
                        request_targets += 1
                    }
                    None => {}
                    target => panic!("hidden completion exposed the wrong target: {target:?}"),
                }
                assert!(!crate::app::fullscreen::pointer::overlay_contains(
                    &app,
                    area,
                    ratatui::layout::Position::new(column, row)
                ));
            }
        }
        assert!(request_targets > 0);
        assert!(matches!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Thread(ThreadCommand::ResolveRequest(_)))
        ));
    }
}

#[test]
fn switching_to_main_screen_clears_selection() {
    let mut app = App::new();
    app.insert_text("/");
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    app.fullscreen
        .selection
        .begin(ratatui::layout::Position::new(1, 1));
    app.fullscreen
        .selection
        .drag(ratatui::layout::Position::new(3, 1));
    assert!(app.fullscreen.selection.range().is_some());

    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(ConfigEvent::SettingsReceived(settings));

    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    assert!(app.fullscreen.selection.range().is_none());
}

#[test]
fn saved_main_screen_mode_clears_pointer_feedback_and_selection() {
    let mut app = App::new();
    app.insert_text("/");
    let target = crate::app::fullscreen::pointer::PointerTarget::Composer(
        crate::thread::composer::ChatComposerPointerTarget::CompletionItem(0),
    );
    app.fullscreen.pointer.update_hover(Some(target.clone()));
    app.fullscreen.pointer.update_pressed(Some(target));
    app.fullscreen
        .selection
        .begin(ratatui::layout::Position::new(2, 1));
    app.fullscreen
        .selection
        .drag(ratatui::layout::Position::new(4, 1));
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(ConfigEvent::Updated(crate::config::ConfigEditResult {
        terminal: settings,
        status_line: StatusLineSettings::default(),
        choices: config_choices(
            &empty_config_snapshot(),
            &ProviderListResult { providers: vec![] },
            settings,
            StatusLineSettings::default(),
        ),
    }));
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
    assert!(app.fullscreen.selection.range().is_none());
}

#[test]
fn terminal_settings_apply_vim_mode_to_the_active_chat_input() {
    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_input_mode(ChatInputMode::Vim);

    app.update(ConfigEvent::SettingsReceived(settings));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert_eq!(app.thread_presentations.active().input.prompt(), "N ");
}

#[test]
fn tab_completes_the_selected_slash_command_without_executing_it() {
    let mut app = App::new();
    app.insert_text("/q");

    let action = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert_eq!(action, None);
    assert_eq!(app.input(), "/quit ");
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn at_file_popup_completes_an_atomic_path_before_submission() {
    let dir = temporary_dir("mention-completion");
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("src/lib.rs"), "fn main() {}").unwrap();
    let mut app = App::for_dir(&dir);
    app.insert_text("review @lib");
    wait_for_mention_results(&mut app, &dir);

    assert!(matches!(
        app.completion(),
        Some(CompletionView::Mention(view)) if view.matches[0].label == "src/lib.rs"
    ));
    let completion = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(completion, None);
    assert_eq!(app.input(), "review src/lib.rs ");
    assert_eq!(app.status(), &Status::Ready);

    let submission = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_text_submission(submission, "review src/lib.rs");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn escape_dismisses_an_at_file_popup_and_is_inert_on_the_session_screen() {
    let dir = temporary_dir("mention-dismiss");
    fs::write(dir.join("notes.md"), "notes").unwrap();
    let mut app = App::for_dir(&dir);
    app.insert_text("@notes");

    let dismissed = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert_eq!(dismissed, None);
    assert!(app.completion().is_none());
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        None
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn escape_does_not_exit_the_idle_session_screen() {
    let mut app = App::new();

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn explicit_navigation_closes_panels_while_context_updates_preserve_them() {
    let mut app = App::new();
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![ListSelectionItem::new("/status")],
        )],
    )));
    assert!(app.command_panel().is_some());

    enter_test_session(&mut app);
    assert!(app.command_panel().is_some());
    app.show_conversation();
    assert!(app.command_panel().is_none());

    let usage = ash_protocol::ModelUsageSummary::default();
    let reference_cost = ash_protocol::ModelReferenceCostSummary::default();
    app.update(StatusEvent::PanelOpened(status_panel(StatusViewData {
        model: "openai/gpt",
        full_context_window: None,
        available_context_window: None,
        remaining_context_window: crate::status::RemainingContextWindow::Unknown,
        usage: &usage,
        reference_cost: &reference_cost,
        session_id: "session-1",
        thread_id: "thread-1",
    })));
    assert!(app.command_panel().is_some());
    app.update(ThreadEvent::ContextChanged {
        session_id: SessionId::new("other-session").unwrap(),
        thread_id: ThreadId::new("other-thread").unwrap(),
    });
    assert!(app.command_panel().is_some());
    app.show_conversation();
    assert!(app.command_panel().is_none());
}

#[test]
fn switching_threads_restores_local_commands_after_receiving_a_snapshot() {
    let mut app = App::new();
    let session_id = SessionId::new("local-history").unwrap();
    let first = ThreadId::new("first").unwrap();
    app.update(ThreadEvent::ContextChanged {
        session_id: session_id.clone(),
        thread_id: first.clone(),
    });
    app.insert_text("/status");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let before = app
        .transcript_views()
        .iter()
        .map(|cell| (cell.cell_id.clone(), cell.text().into_owned()))
        .collect::<Vec<_>>();
    assert!(before.iter().any(|(_, text)| text.contains("/status")));
    for index in 0..35 {
        app.update(ThreadEvent::ContextChanged {
            session_id: session_id.clone(),
            thread_id: ThreadId::new(format!("other-{index}")).unwrap(),
        });
        assert!(app.transcript_views().is_empty());
        app.update(ThreadEvent::FailureReported(format!(
            "other thread {index}"
        )));
    }
    app.update(ThreadEvent::ContextChanged {
        session_id: session_id.clone(),
        thread_id: first.clone(),
    });
    for _ in 0..2 {
        app.update(ThreadEvent::TranscriptSnapshotReceived(
            ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot {
                session_id: session_id.clone(),
                thread_id: first.clone(),
                durable_sequence: 1,
                revision: 1,
                entries: vec![],
            },
        ));
        let after = app
            .transcript_views()
            .iter()
            .map(|cell| (cell.cell_id.clone(), cell.text().into_owned()))
            .collect::<Vec<_>>();
        assert_eq!(after, before);
    }
    app.update(ThreadEvent::TranscriptCleared);
    app.update(ThreadEvent::ContextChanged {
        session_id: session_id.clone(),
        thread_id: ThreadId::new("other-0").unwrap(),
    });
    assert!(
        app.transcript_views()
            .iter()
            .any(|cell| cell.text().contains("other thread 0"))
    );
    app.update(ThreadEvent::ContextChanged {
        session_id,
        thread_id: first,
    });
    assert!(app.transcript_views().is_empty());
}

#[test]
fn two_screen_escape_presses_within_the_gesture_window_open_rewind() {
    let mut app = App::new();
    let started = Instant::now();

    assert_eq!(
        app.handle_key_at(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), started,),
        None
    );
    assert_eq!(
        app.handle_key_at(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            started + Duration::from_millis(200),
        ),
        Some(AppCommand::Thread(ThreadCommand::OpenRewindPicker))
    );
}

#[test]
fn screen_escape_gesture_preserves_a_nonempty_draft() {
    let mut app = App::new();
    let started = Instant::now();
    app.insert_text("keep this draft");

    assert_eq!(
        app.handle_key_at(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), started),
        None
    );
    assert_eq!(
        app.handle_key_at(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            started + Duration::from_millis(200),
        ),
        None
    );
    assert_eq!(app.input(), "keep this draft");
}

#[test]
fn escape_from_command_panel_does_not_count_toward_the_screen_rewind_sequence() {
    let mut app = App::new();
    let started = Instant::now();
    assert_eq!(
        app.handle_key_at(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), started),
        None
    );
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Feature",
        vec![ListSelectionGroup::new(
            "Items",
            vec![ListSelectionItem::new("Item")],
        )],
    )));

    assert_eq!(
        app.handle_key_at(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            started + Duration::from_millis(100),
        ),
        None
    );
    assert!(app.list_selection().is_none());
    assert_eq!(
        app.handle_key_at(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            started + Duration::from_millis(200),
        ),
        None
    );
}

#[test]
fn screen_escape_gesture_expires_and_is_reset_by_other_input() {
    let mut app = App::new();
    let started = Instant::now();
    let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);

    assert_eq!(app.handle_key_at(escape, started), None);
    assert_eq!(
        app.handle_key_at(escape, started + Duration::from_millis(600)),
        None
    );
    app.handle_key_at(
        KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        started + Duration::from_millis(650),
    );
    assert_eq!(
        app.handle_key_at(escape, started + Duration::from_millis(700)),
        None
    );
}

#[test]
fn control_c_interrupts_a_working_turn_without_exiting() {
    let mut app = App::new();
    app.insert_text("hello");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert_eq!(action, Some(AppCommand::Thread(ThreadCommand::Interrupt)));
    assert_eq!(app.status(), &Status::Cancelling);
}

#[test]
fn a_second_control_c_does_not_duplicate_an_interrupt() {
    let mut app = App::new();
    app.insert_text("hello");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert_eq!(action, None);
    assert_eq!(app.status(), &Status::Cancelling);
}

#[test]
fn control_c_interrupts_a_turn_waiting_for_user_input() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(
        TurnActivity::WaitingForUserInput,
    ));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert_eq!(action, Some(AppCommand::Thread(ThreadCommand::Interrupt)));
    assert_eq!(app.status(), &Status::Cancelling);
}

#[test]
fn control_enter_steers_the_working_turn_and_tracks_delivery() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));

    app.insert_text("second");
    app.handle_paste("third".into());
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL));

    let Some(AppCommand::Thread(ThreadCommand::SteerTurn {
        steer_id,
        submission,
    })) = action
    else {
        panic!("expected active Turn steer");
    };
    assert_eq!(submission.display_text, "secondthird");
    assert_eq!(app.input(), "");
    assert_eq!(app.messages().len(), 2);
    assert_eq!(app.messages()[1].text(), "secondthird");
    assert!(app.command_panel().is_none());

    app.update(ThreadEvent::SteerCompleted { steer_id });

    assert!(app.command_panel().is_none());
    assert_eq!(app.status(), &Status::Working);
}

#[test]
fn queue_selection_requests_durable_steering_of_the_selected_message() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.set_active_turn(ash_protocol::TurnId::new("running").unwrap());
    let mut messages = Vec::new();
    for text in ["second", "third"] {
        app.insert_text(text);
        let action = app
            .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        messages.push(crate::test_support::queued_message(action));
        app.update(ThreadEvent::QueueReceived {
            messages: messages.clone(),
            restore: None,
        });
    }
    let first = app.queue_view().items[0].id;
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL));
    let Some(AppCommand::Thread(ThreadCommand::EditQueue {
        target,
        action: crate::thread::queue::QueueAction::Send(turn),
    })) = action
    else {
        panic!("expected durable queue send")
    };
    assert_eq!(target.queue_id, first);
    assert_eq!(turn.unwrap().as_str(), "running");
    assert!(app.queue_view().items[0].sending);
    messages[0].status = ::queue::QueueStatus::Started;
    messages[0].revision = 2;
    app.update(ThreadEvent::QueueReceived {
        messages,
        restore: None,
    });
    assert_eq!(app.queue_view().items.len(), 1);
    assert_eq!(app.queue_view().items[0].text, "third");
}

#[test]
fn enter_queues_a_new_turn_by_default_while_the_current_turn_is_working() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("next turn");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(AppCommand::Thread(ThreadCommand::Enqueue { .. }))
    ));
    assert_eq!(app.queue_view().items[0].text, "next turn");
    assert_eq!(app.status(), &Status::Working);

    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(app.input(), "next turn");
    assert_eq!(app.queue_view().items[0].text, "next turn");
}

#[test]
fn queue_restore_waits_for_backend_pause_before_editing() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("restore me");
    let action = app
        .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    let mut message = crate::test_support::queued_message(action);
    app.update(ThreadEvent::QueueReceived {
        messages: vec![message.clone()],
        restore: None,
    });
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
    assert!(app.queue_focused());
    let Some(AppCommand::Thread(ThreadCommand::EditQueue {
        target,
        action: crate::thread::queue::QueueAction::Pause,
    })) = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected pause")
    };
    assert_eq!(app.input(), "");
    message.status = ::queue::QueueStatus::Paused;
    message.revision = 2;
    app.update(ThreadEvent::QueueReceived {
        messages: vec![message],
        restore: Some(target.queue_id),
    });
    assert_eq!(app.input(), "restore me");
    assert!(app.queue_view().items[0].editing);
}

#[test]
fn queue_focus_keeps_global_interrupt_available() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("queued");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    );
}

#[test]
fn dashboard_command_opens_the_manager_screen() {
    for command in ["/dashboard"] {
        let mut app = App::new();
        app.insert_text(command);

        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            None
        );
        assert!(app.session_manager_view().is_some());
    }
}

#[test]
fn project_folder_picker_switches_only_to_a_non_current_root_without_a_draft() {
    use ash_app_server_protocol::protocol::projects::ProjectDto;
    use ash_app_server_protocol::protocol::projects::ProjectRootDto;
    use ash_app_server_protocol::protocol::projects::ProjectStatusDto;
    use ash_file_access::DirId;
    use ash_file_access::EnvId;
    let workspace = tempfile::tempdir().unwrap();
    let current = workspace.path().join("current");
    let other = workspace.path().join("other");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&other).unwrap();
    let mut app = App::for_dir(&current);
    let dir_id = |seed: char| {
        format!("sha256:{}", seed.to_string().repeat(64))
            .parse::<DirId>()
            .unwrap()
    };
    let project = ProjectDto {
        project_id: ash_protocol::ProjectId::new("project").unwrap(),
        revision: 1,
        status: ProjectStatusDto::Active,
        name: "Project".into(),
        description: String::new(),
        roots: vec![
            ProjectRootDto {
                environment_id: EnvId::local(),
                dir_id: dir_id('a'),
                path: url::Url::from_file_path(&current)
                    .unwrap()
                    .as_str()
                    .parse()
                    .unwrap(),
                name: "current".into(),
                purpose: String::new(),
            },
            ProjectRootDto {
                environment_id: EnvId::local(),
                dir_id: dir_id('b'),
                path: url::Url::from_file_path(&other)
                    .unwrap()
                    .as_str()
                    .parse()
                    .unwrap(),
                name: "other".into(),
                purpose: String::new(),
            },
        ],
        session_ids: Vec::new(),
    };
    app.update(crate::projects::Event::RootsOpened(
        crate::projects::root_choices(&project, &current).unwrap(),
    ));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Dirs(crate::dirs::Command::MoveSession { path })) if path == other
    ));
    assert!(app.command_panel().is_none());

    let mut app = App::for_dir(&current);
    app.insert_text("keep this draft");
    app.update(crate::projects::Event::RootsOpened(
        crate::projects::root_choices(&project, &current).unwrap(),
    ));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Dirs(crate::dirs::Command::MoveSession { path })) if path == other
    ));
    assert_eq!(app.input(), "keep this draft");
    assert!(app.command_panel().is_none());
}

#[test]
fn project_folder_picker_opens_add_root_when_add_item_is_selected() {
    use ash_app_server_protocol::protocol::projects::ProjectDto;
    use ash_app_server_protocol::protocol::projects::ProjectRootDto;
    use ash_app_server_protocol::protocol::projects::ProjectStatusDto;
    use ash_file_access::DirId;
    use ash_file_access::EnvId;
    let workspace = tempfile::tempdir().unwrap();
    let current = workspace.path().join("current");
    std::fs::create_dir(&current).unwrap();
    let mut app = App::for_dir(&current);
    let dir_id = |seed: char| {
        format!("sha256:{}", seed.to_string().repeat(64))
            .parse::<DirId>()
            .unwrap()
    };
    let project = ProjectDto {
        project_id: ash_protocol::ProjectId::new("project").unwrap(),
        revision: 1,
        status: ProjectStatusDto::Active,
        name: "Project".into(),
        description: String::new(),
        roots: vec![ProjectRootDto {
            environment_id: EnvId::local(),
            dir_id: dir_id('a'),
            path: url::Url::from_file_path(&current)
                .unwrap()
                .as_str()
                .parse()
                .unwrap(),
            name: "current".into(),
            purpose: String::new(),
        }],
        session_ids: Vec::new(),
    };
    app.update(crate::projects::Event::RootsOpened(
        crate::projects::root_choices(&project, &current).unwrap(),
    ));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Projects(crate::projects::Command::OpenAddRoot))
    ));
    assert!(app.command_panel().is_some());
}

#[test]
fn manager_session_keys_archive_show_details_and_open_the_selected_session() {
    let mut app = App::new();
    app.update(SessionEvent::CatalogReceived(vec![
        manager_state_session("one"),
        manager_state_session("two"),
    ]));
    app.insert_text("/dashboard");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(
        app.session_manager_hint().text(),
        "Enter to open · Space to preview · Ctrl+X to archive · i to details · Esc to return"
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)),
        Some(AppCommand::Sessions(SessionCommand::Archive {
            session_ids: vec![SessionId::new("one").unwrap()],
        }))
    );

    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('i'), KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.overlay().unwrap().title(), "Session details");
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.overlay().is_none());
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.session_manager_hint().text(),
        "Enter to open · Space to preview · Ctrl+X to archive · i to details · Esc to return"
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Sessions(SessionCommand::Resume {
            session_id: "two".into(),
            preferred_thread_id: None,
        }))
    );
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)),
        Some(AppCommand::Sessions(SessionCommand::Archive {
            session_ids: vec![SessionId::new("two").unwrap()],
        }))
    );
}

#[test]
fn rejected_enqueue_keeps_the_draft_and_retry_identity() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("keep this message");
    let Some(AppCommand::Thread(ThreadCommand::Enqueue {
        queue_id,
        command_id,
        ..
    })) = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected enqueue")
    };
    app.update(ThreadEvent::QueueFailed {
        queue_id: Some(queue_id),
        error: "server unavailable".into(),
    });
    assert!(!app.queue_view().items[0].sending);
    let Some(AppCommand::Thread(ThreadCommand::Enqueue {
        command_id: retry, ..
    })) = app.send_queued_message(queue_id)
    else {
        panic!("expected retry")
    };
    assert_eq!(retry, command_id);
    assert_eq!(app.queue_view().items[0].text, "keep this message");
}

#[test]
fn empty_enter_does_not_bypass_queue_dispatch_order() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("send this now");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    assert_eq!(app.queue_view().items[0].text, "send this now");
}

#[test]
fn a_created_turn_does_not_claim_the_running_steer_action() {
    let mut app = App::new();
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Starting));
    app.insert_text("after the queued turn");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(AppCommand::Thread(ThreadCommand::Enqueue { .. }))
    ));
    assert_eq!(app.queue_view().items[0].text, "after the queued turn");
    assert_eq!(app.status(), &Status::Working);
}

#[test]
fn rejected_steer_removes_only_its_pending_row_and_keeps_the_turn_working() {
    let mut app = App::new();
    app.insert_text("first");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    app.insert_text("change direction");
    let Some(AppCommand::Thread(ThreadCommand::SteerTurn { steer_id, .. })) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL))
    else {
        panic!("expected active Turn steer");
    };

    app.update(ThreadEvent::SteerSubmissionFailed {
        steer_id,
        error: "sequence conflict".into(),
    });

    assert!(app.command_panel().is_none());
    assert_eq!(app.status(), &Status::Working);
    assert!(
        app.messages()
            .last()
            .unwrap()
            .text()
            .contains("could not steer the active Turn: sequence conflict")
    );
}

#[test]
fn completion_returns_the_app_to_ready_without_appending_transcript_content() {
    let mut app = App::new();
    app.insert_text("hello");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    app.update(ThreadEvent::TurnCompleted);

    assert_eq!(app.messages().len(), 1);
    assert_eq!(app.messages()[0].role(), MessageRole::User);
    assert_eq!(app.messages()[0].text(), "hello");
    assert_eq!(app.status(), &Status::Ready);
}

#[test]
fn client_error_is_visible_in_history_and_status() {
    let mut app = App::new();

    app.update(ThreadEvent::FailureReported("provider unavailable".into()));

    assert_eq!(app.messages().len(), 1);
    assert_eq!(app.messages()[0].role(), MessageRole::Error);
    assert_eq!(app.messages()[0].text(), "provider unavailable");
    assert_eq!(app.status(), &Status::Error);
}

#[test]
fn interrupted_turn_returns_to_ready_with_a_notice() {
    let mut app = App::new();
    app.insert_text("hello");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    app.update(ThreadEvent::TurnInterrupted);

    assert_eq!(app.status(), &Status::Ready);
    assert_eq!(app.messages().last().unwrap().role(), MessageRole::Notice);
    assert_eq!(app.messages().last().unwrap().text(), "turn interrupted");
}

fn assert_text_submission(action: Option<AppCommand>, expected: &str) {
    let Some(AppCommand::Thread(ThreadCommand::SubmitTurn { submission })) = action else {
        panic!("expected text submission");
    };
    assert_eq!(submission.display_text, expected);
    assert_eq!(
        submission.input,
        vec![ChatInputItem::Text(expected.to_owned())]
    );
}

#[test]
fn backtab_cycles_the_next_turn_approval_mode() {
    let mut app = App::new();

    let action = app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::CycleNextApprovalMode))
    );
    assert_eq!(app.approval_mode(), ApprovalMode::AskPermissions);

    app.set_next_approval_mode(ApprovalMode::AutoReview);
    let action = app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::CycleNextApprovalMode))
    );
}

fn wait_for_mention_results(app: &mut App, dir: &Path) {
    let mut file_search = FileSearchManager::new(dir.to_path_buf());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(query) = app.mention_query() {
            file_search.update_query(query);
        } else {
            file_search.stop();
        }
        for snapshot in file_search.poll() {
            app.update(ThreadEvent::FileSearchSnapshotReceived(snapshot));
        }
        if matches!(
            app.completion(),
            Some(CompletionView::Mention(popup)) if !popup.matches.is_empty()
        ) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for mention search results"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn temporary_dir(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ash-tui-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn manager_state_session(id: &str) -> Session {
    Session {
        session_id: SessionId::new(id).unwrap(),
        title: id.into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }
}

#[test]
fn panel_search_owns_letters_and_paste_then_returns_to_the_list_and_original_draft() {
    let mut app = App::new();
    app.insert_text("original draft");
    app.update(AppEvent::HelpOpened(
        crate::widgets::list_selection::ListSelectionModel::new(
            "Help",
            vec![crate::widgets::list_selection::ListSelectionGroup::new(
                "All",
                vec![
                    crate::widgets::list_selection::ListSelectionItem::new("first"),
                    crate::widgets::list_selection::ListSelectionItem::new("jk/i p pasted"),
                ],
            )],
        )
        .with_search(crate::widgets::search_box::SearchBoxModel::new("Search")),
    ));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
        None
    );
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    for character in "jk/i p".chars() {
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)),
            None
        );
    }
    app.handle_paste(" pasted".into());
    assert_eq!(app.input(), "original draft");
    assert!(
        app.list_selection()
            .unwrap()
            .search()
            .unwrap()
            .input_active()
    );
    assert_eq!(
        app.command_panel_key_hints().map(|hints| hints.text()),
        Some("Enter/Esc/Ctrl+C to return  ·  Tab/Shift+Tab to switch")
    );
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(
        !app.list_selection()
            .unwrap()
            .search()
            .unwrap()
            .input_active()
    );
    assert!(app.command_panel().is_some());
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "original draft");
}

#[test]
fn fork_rejects_image_arguments_before_session_creation() {
    let mut app = App::new();
    app.insert_text("/fork ");
    app.update(HostEvent::ClipboardImageRead {
        target: app.draft_target(),
        result: Ok(ClipboardImage {
            png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
            fingerprint: ClipboardImageFingerprint(1),
            width: 1,
            height: 1,
        }),
    });
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        None
    );
    assert!(
        app.messages()
            .last()
            .unwrap()
            .detail()
            .unwrap()
            .contains("do not accept image arguments")
    );
}

#[test]
fn xai_subscription_login_stays_separate_from_chatgpt_after_navigation() {
    use crate::config::SubscriptionCommand;
    use crate::config::SubscriptionEvent;
    use crate::config::SubscriptionProvider;
    use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
    use ash_app_server_protocol::protocol::account::AccountReadResult;
    let mut app = App::new();
    assert_eq!(
        enter_provider_row(&mut app, "Super Grok"),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            SubscriptionProvider::Xai,
            SubscriptionCommand::Read
        )))
    );
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Xai,
        SubscriptionEvent::Read {
            account: AccountReadResult {
                revision: 1,
                accounts: vec![],
            },
            models: None,
        },
    ));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            SubscriptionProvider::Xai,
            SubscriptionCommand::SignIn
        )))
    );
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Xai,
        SubscriptionEvent::Started {
            login: AccountLoginStartResult::DeviceCode {
                login_id: "xai-login".into(),
                verification_url: "https://auth.x.ai/device".into(),
                user_code: "XAI-1234".into(),
            },
            browser_error: None,
        },
    ));
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("XAI-1234") && screen.contains("https://auth.x.ai/device"));
    crate::tui_assert_snapshot!("xai_subscription_device_login", screen);
    for _ in 0..2 {
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    }
    assert_eq!(
        enter_provider_row(&mut app, "ChatGPT"),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Read
        )))
    );
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::ChatGpt,
        SubscriptionEvent::Read {
            account: AccountReadResult {
                revision: 1,
                accounts: vec![],
            },
            models: None,
        },
    ));
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("Sign in with ChatGPT"));
    assert!(!screen.contains("XAI-1234"));
    for _ in 0..2 {
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    }
    enter_provider_row(&mut app, "Super Grok");
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Xai,
        SubscriptionEvent::Read {
            account: AccountReadResult {
                revision: 1,
                accounts: vec![],
            },
            models: None,
        },
    ));
    assert!(crate::app::usage_tests::render(&app, 96, 24).contains("XAI-1234"));
}

#[test]
fn xai_subscription_browser_failure_keeps_the_manual_challenge_visible() {
    use crate::config::SubscriptionEvent;
    use crate::config::SubscriptionProvider;
    use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
    use ash_app_server_protocol::protocol::account::AccountReadResult;
    let mut app = App::new();
    enter_provider_row(&mut app, "Super Grok");
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Xai,
        SubscriptionEvent::Read {
            account: AccountReadResult {
                revision: 1,
                accounts: vec![],
            },
            models: None,
        },
    ));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Xai,
        SubscriptionEvent::Started {
            login: AccountLoginStartResult::DeviceCode {
                login_id: "xai-login".into(),
                verification_url: "https://auth.x.ai/device".into(),
                user_code: "XAI-1234".into(),
            },
            browser_error: Some("browser command unavailable".into()),
        },
    ));
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("Could not open browser"));
    assert!(screen.contains("https://auth.x.ai/device"));
    assert!(screen.contains("XAI-1234"));
    crate::tui_assert_snapshot!("xai_subscription_browser_failure", screen);
}

#[test]
fn zai_subscription_accepts_a_masked_key_and_returns_to_its_status() {
    use crate::config::PlanStatus;
    use crate::config::SubscriptionEvent;
    use crate::config::SubscriptionProvider;

    let mut app = App::new();
    assert_eq!(
        enter_provider_row(&mut app, "BigModel"),
        Some(AppCommand::Config(ConfigCommand::Subscription(
            SubscriptionProvider::Zai,
            crate::config::SubscriptionCommand::Read,
        )))
    );
    app.update(ConfigEvent::SubscriptionReply(
        SubscriptionProvider::Zai,
        SubscriptionEvent::Plan(PlanStatus {
            key_saved: false,
            enabled: false,
        }),
    ));
    crate::tui_assert_snapshot!(
        "zai_subscription_sign_in",
        crate::app::usage_tests::render(&app, 96, 24)
    );
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "Sign in with BigModel"
    );
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .is_none()
    );
    app.handle_paste("secret-zai-key".into());
    let screen = crate::app::usage_tests::render(&app, 96, 24);
    assert!(screen.contains("BigModel › API key"));
    assert!(!screen.contains("secret-zai-key"));
    assert!(app.list_selection().is_none());
    crate::tui_assert_snapshot!("zai_subscription_key_prompt", screen);

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.list_selection().unwrap().title(), "BigModel");
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .is_none()
    );
    app.handle_paste("secret-zai-key".into());
    let Some(AppCommand::Config(ConfigCommand::SetProviderApiKey(edit))) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected zai key save");
    };
    assert!(!format!("{edit:?}").contains("secret-zai-key"));
    assert_eq!(edit.into_parts(), ("zai".into(), "secret-zai-key".into()));

    app.update(ConfigEvent::ApiKeySaved {
        provider: "zai".into(),
        choices: config_choices(
            &empty_config_snapshot(),
            &ProviderListResult { providers: vec![] },
            TerminalSettings::default(),
            StatusLineSettings::default(),
        ),
        plan: Some(PlanStatus {
            key_saved: true,
            enabled: true,
        }),
    });
    let labels = app
        .list_selection()
        .unwrap()
        .visible_items()
        .iter()
        .map(|item| item.label())
        .collect::<Vec<_>>();
    assert!(!labels.iter().any(|label| label.contains("API key")));
    assert!(labels.contains(&"Coding plan enabled"));
    assert!(labels.contains(&"Disable BigModel"));
    crate::tui_assert_snapshot!(
        "zai_subscription_configured",
        crate::app::usage_tests::render(&app, 96, 24)
    );
}
