use super::App;
use super::AppCommand;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::terminal::ScreenMode;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadRequestKind;
use crate::thread::interaction::approval::Approval;
use crate::thread::interaction::approval::ApprovalSpec;
use crate::thread::interaction::query::Query;
use crate::thread::interaction::query::QueryChoice;
use crate::thread::interaction::query::QueryCustomAnswer;
use crate::thread::interaction::query::QueryQuestion;
use ash_protocol::AgentResponse;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use unicode_width::UnicodeWidthStr;

#[test]
fn query_keeps_its_draft_and_renders_edit_submission_failure_and_retry() {
    let mut app = App::new();
    app.insert_text("chat draft stays here");
    app.update(ThreadEvent::QueryRequested(
        Query::new(vec![QueryQuestion {
            id: "next".into(),
            header: "Next step".into(),
            prompt: "How should the work continue?".into(),
            choices: vec![QueryChoice {
                label: "Continue".into(),
                description: "Use the proposed approach".into(),
            }],
            custom_answer: QueryCustomAnswer::Allowed,
        }])
        .unwrap(),
    ));
    assert!(app.query_view().is_some());
    crate::tui_assert_snapshot!("query_open", render(&app, 80, 20));
    crate::tui_assert_snapshot!("query_open_narrow", render(&app, 42, 20));
    crate::tui_assert_snapshot!("query_open_short", render(&app, 42, 16));

    app.handle_key(key(KeyCode::Down));
    app.handle_key(key(KeyCode::Enter));
    app.handle_paste("Keep the user draft".into());
    assert_eq!(
        app.query_view().unwrap().custom_answer,
        Some("Keep the user draft")
    );
    crate::tui_assert_snapshot!("query_custom_answer", render(&app, 80, 20));

    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("query answer must resolve the active request");
    };
    assert_eq!(response.kind, ThreadRequestKind::Query);
    let AgentResponse::UserInput { response: answers } = &response.response else {
        panic!("query response must contain user input answers");
    };
    assert_eq!(answers.answers["next"].value, "Keep the user draft");
    assert_eq!(app.input(), "chat draft stays here");
    assert!(app.query_view().unwrap().submitting);
    crate::tui_assert_snapshot!("query_submitting", render(&app, 80, 20));
    set_screen_mode(&mut app, ScreenMode::Inline);
    crate::tui_assert_snapshot!("query_submitting_inline", render(&app, 80, 20));
    set_screen_mode(&mut app, ScreenMode::Fullscreen);

    app.update(ThreadEvent::RequestSubmissionFailed {
        request: response.identity(),
        error: "offline".into(),
    });
    assert_eq!(app.query_view().unwrap().error, Some("offline"));
    crate::tui_assert_snapshot!("query_submission_failed", render(&app, 80, 20));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response)))
    );
}

#[test]
fn approval_renders_submission_and_failure_while_preserving_the_chat_draft() {
    let mut app = App::new();
    app.insert_text("unfinished chat draft");
    app.update(ThreadEvent::ApprovalRequested(Approval::new(
        ApprovalSpec {
            title: "Approval required".into(),
            reason: "Run the requested command?".into(),
            details: vec!["Process spawn  ·  cargo test".into()],
        },
    )));
    crate::tui_assert_snapshot!("approval_open", render(&app, 80, 20));

    let Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response))) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("approval must resolve the active request");
    };
    assert_eq!(response.kind, ThreadRequestKind::Approval);
    assert_eq!(app.input(), "unfinished chat draft");
    assert!(app.approval_view().unwrap().submitting);
    crate::tui_assert_snapshot!("approval_submitting", render(&app, 80, 20));
    set_screen_mode(&mut app, ScreenMode::Inline);
    crate::tui_assert_snapshot!("approval_submitting_inline", render(&app, 80, 20));
    set_screen_mode(&mut app, ScreenMode::Fullscreen);

    app.update(ThreadEvent::RequestSubmissionFailed {
        request: response.identity(),
        error: "offline".into(),
    });
    assert_eq!(app.approval_view().unwrap().error, Some("offline"));
    crate::tui_assert_snapshot!("approval_submission_failed", render(&app, 80, 20));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Thread(ThreadCommand::ResolveRequest(response)))
    );
}

#[test]
fn connection_recovery_restores_home_and_conversation_drafts() {
    let mut previous = App::new();
    previous.insert_text("conversation draft");
    previous.open_home();
    previous.insert_text("new task draft");
    let drafts = previous.recovery_drafts();
    let diagnostics = format!("{drafts:?}");
    assert!(!diagnostics.contains("conversation draft"));
    assert!(!diagnostics.contains("new task draft"));

    let mut restored = App::new();
    restored.restore_recovery_drafts(drafts);
    assert!(restored.fullscreen_home_visible());
    assert_eq!(restored.input(), "new task draft");
    crate::tui_assert_snapshot!("recovered_home_draft", render(&restored, 80, 20));

    restored.show_conversation();
    assert!(!restored.fullscreen_home_visible());
    assert_eq!(restored.input(), "conversation draft");
    crate::tui_assert_snapshot!("recovered_conversation_draft", render(&restored, 80, 20));
}

#[test]
fn model_errors_keep_their_actions_visible_in_the_conversation() {
    let mut app = App::new();
    for error in [
        "Check your provider and model configuration in /config.",
        "Authentication failed (401). Check your provider credentials in /config.",
        "Too many requests (429). Try again later.",
    ] {
        app.update(ThreadEvent::FailureReported(error.into()));
    }

    let frame = render(&app, 80, 20);
    assert!(frame.contains("Check your provider and model configuration in /config."));
    assert!(frame.contains("Authentication failed (401)."));
    assert!(frame.contains("Too many requests (429)."));
    crate::tui_assert_snapshot!("model_errors_in_conversation", frame);
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn set_screen_mode(app: &mut App, mode: ScreenMode) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    app.update(ConfigEvent::SettingsReceived(settings));
}

fn render(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|row| {
            let mut text = String::new();
            let mut column = 0;
            while column < width {
                let symbol = buffer[(column, row)].symbol();
                text.push_str(symbol);
                column = column.saturating_add(
                    u16::try_from(UnicodeWidthStr::width(symbol).max(1)).unwrap_or(1),
                );
            }
            text.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
