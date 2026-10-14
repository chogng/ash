use super::*;
use crate::app::App;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::widgets::list_selection::ListSelectionState;

#[test]
fn ide_picker_keeps_window_names_verbatim_and_localizes_context() {
    let window = IdeWindow {
        id: "12345678901234567890123456789012".into(),
        title: "My project".into(),
        roots: vec!["/project".into()],
    };
    let mut view = choices(std::slice::from_ref(&window));
    view.model.localize(Language::Chinese);
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.title(), "Ash IDE");
    assert_eq!(
        view.actions.get(&ListSelectionItemId::new(&window.id)),
        Some(&Command::Connect(window.id))
    );
    assert_eq!(
        crate::nls::localize(Language::Chinese, "IDE context"),
        "IDE 上下文"
    );
    let mut notice = connection_notice(Some(&IdeWindow {
        id: "id".into(),
        title: "My project".into(),
        roots: vec![],
    }));
    notice.localize(Language::Chinese);
    assert_eq!(
        notice.to_string(),
        "已连接 My project。新消息将附带编辑器上下文。"
    );
}

#[test]
fn ide_picker_keyboard_selection_and_escape_restore_composer() {
    let window = IdeWindow {
        id: "12345678901234567890123456789012".into(),
        title: "Project".into(),
        roots: vec!["/project".into()],
    };
    let mut app = App::new();
    app.update(Event::Opened(choices(std::slice::from_ref(&window))));
    assert_eq!(app.list_selection().unwrap().title(), "Ash IDE");
    assert!(
        matches!(app.handle_key(KeyEvent::new(crossterm::event::KeyCode::Enter, crossterm::event::KeyModifiers::NONE)), Some(crate::app::AppCommand::Ide(Command::Connect(id))) if id == window.id)
    );
    app.update(Event::Opened(choices(&[])));
    app.handle_key(KeyEvent::new(
        crossterm::event::KeyCode::Esc,
        crossterm::event::KeyModifiers::NONE,
    ));
    assert!(app.list_selection().is_none());
}

struct ScriptedTransport(std::collections::VecDeque<(IdeRequest, IdeResult)>);
impl JsonRpcTransport for ScriptedTransport {
    fn round_trip(&mut self, raw: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(raw).unwrap();
        let (expected, response) = self.0.pop_front().expect("unexpected IDE request");
        assert_eq!(request["method"], "ide/request");
        assert_eq!(request["params"], serde_json::to_value(expected).unwrap());
        Ok(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":response}).to_string())
    }
}

#[test]
fn ide_toggle_automatically_matches_the_workspace_and_repeated_command_disconnects() {
    let window = IdeWindow {
        id: "12345678901234567890123456789012".into(),
        title: "Project".into(),
        roots: vec!["/project".into()],
    };
    let unrelated = IdeWindow {
        id: "12345678901234567890123456789013".into(),
        title: "Other".into(),
        roots: vec!["/elsewhere".into()],
    };
    let mut client = AppServerClient::new(ScriptedTransport(
        [
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    preferred: None,
                    windows: vec![unrelated, window.clone()],
                    selected: None,
                },
            ),
            (
                IdeRequest::Connect {
                    window_id: window.id.clone(),
                },
                IdeResult::Connected {
                    window: Some(window.clone()),
                },
            ),
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    preferred: None,
                    windows: vec![window.clone()],
                    selected: Some(window),
                },
            ),
            (
                IdeRequest::Disconnect {},
                IdeResult::Connected { window: None },
            ),
        ]
        .into(),
    ));
    let mut app = App::new();
    assert!(
        !app.status_line()
            .top_text_for_width(80, app.status_line_runtime())
            .contains("IDE")
    );
    app.update(toggle(&mut client, Path::new("/project/src"), "").unwrap());
    assert!(
        app.list_selection().is_none(),
        "one matching window connects without a picker"
    );
    assert!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime())
            .contains("IDE context")
    );
    app.update(toggle(&mut client, Path::new("/project/src"), "").unwrap());
    assert!(
        !app.status_line()
            .top_text_for_width(80, app.status_line_runtime())
            .contains("IDE")
    );
}

#[test]
fn ide_toggle_only_offers_matching_windows_and_rejects_subcommands() {
    let windows = vec![
        IdeWindow {
            id: "12345678901234567890123456789012".into(),
            title: "First".into(),
            roots: vec!["/project".into()],
        },
        IdeWindow {
            id: "12345678901234567890123456789013".into(),
            title: "Second".into(),
            roots: vec!["/project".into()],
        },
        IdeWindow {
            id: "12345678901234567890123456789014".into(),
            title: "Other".into(),
            roots: vec!["/elsewhere".into()],
        },
    ];
    let mut client = AppServerClient::new(ScriptedTransport(
        [(
            IdeRequest::List {},
            IdeResult::Windows {
                preferred: None,
                windows,
                selected: None,
            },
        )]
        .into(),
    ));
    let Event::Opened(view) = toggle(&mut client, Path::new("/project"), "").unwrap() else {
        panic!("matching windows require a choice")
    };
    assert_eq!(view.actions.len(), 2);
    for argument in ["status", "disconnect", "off"] {
        assert!(matches!(
            toggle(&mut client, Path::new("/project"), argument).unwrap(),
            Event::Notice(_)
        ));
    }
    assert_eq!(
        crate::thread::composer::TuiSlashCommandAction::Ide
            .definition()
            .argument_mode,
        ash_slash_commands::SlashCommandArgumentMode::None
    );
}

#[test]
fn ide_integrated_terminal_attaches_quietly_and_toggle_returns_to_its_origin() {
    let window = IdeWindow {
        id: "12345678901234567890123456789012".into(),
        title: "Originating window".into(),
        roots: vec!["/project".into()],
    };
    let other = IdeWindow {
        id: "12345678901234567890123456789013".into(),
        title: "Same project in another window".into(),
        roots: vec!["/project".into()],
    };
    let key = "01234567890123456789012345678901";
    let mut client = AppServerClient::new(ScriptedTransport(
        [
            (
                IdeRequest::Attach {
                    window_key: key.into(),
                },
                IdeResult::Connected {
                    window: Some(window.clone()),
                },
            ),
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    windows: vec![other.clone(), window.clone()],
                    selected: Some(window.clone()),
                    preferred: Some(IdeOrigin::Available {
                        window: window.clone(),
                    }),
                },
            ),
            (
                IdeRequest::Disconnect {},
                IdeResult::Connected { window: None },
            ),
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    windows: vec![other.clone(), window.clone()],
                    selected: None,
                    preferred: Some(IdeOrigin::Available {
                        window: window.clone(),
                    }),
                },
            ),
            (
                IdeRequest::Connect {
                    window_id: window.id.clone(),
                },
                IdeResult::Connected {
                    window: Some(window.clone()),
                },
            ),
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    windows: vec![other.clone()],
                    selected: Some(window),
                    preferred: Some(IdeOrigin::Unavailable {}),
                },
            ),
            (
                IdeRequest::Disconnect {},
                IdeResult::Connected { window: None },
            ),
            (
                IdeRequest::List {},
                IdeResult::Windows {
                    windows: vec![other],
                    selected: None,
                    preferred: Some(IdeOrigin::Unavailable {}),
                },
            ),
        ]
        .into(),
    ));
    let mut app = App::new();
    let event = attach(&mut client, key.into()).unwrap();
    assert!(
        matches!(&event, Event::ConnectionChanged { notice, .. } if notice.to_string().is_empty())
    );
    app.update(event);
    assert!(
        app.status_line()
            .top_text_for_width(80, app.status_line_runtime())
            .contains("IDE context")
    );
    app.update(toggle(&mut client, Path::new("/project"), "").unwrap());
    app.update(toggle(&mut client, Path::new("/project"), "").unwrap());
    assert!(
        app.list_selection().is_none(),
        "known originating windows never need a picker"
    );
    app.update(toggle(&mut client, Path::new("/project"), "").unwrap());
    app.update(toggle(&mut client, Path::new("/project"), "").unwrap());
    assert!(app.list_selection().is_none());
    assert!(
        !app.status_line()
            .top_text_for_width(80, app.status_line_runtime())
            .contains("IDE")
    );
}

#[test]
fn desktop_handoff_uses_the_existing_identity_and_only_accepts_an_opened_acknowledgement() {
    let session_id = ash_protocol::SessionId::new("session").unwrap();
    let thread_id = ash_protocol::ThreadId::new("thread").unwrap();
    let request = IdeRequest::OpenConversation {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
    };
    let mut client = AppServerClient::new(ScriptedTransport(
        [
            (request.clone(), IdeResult::ConversationBusy {}),
            (request.clone(), IdeResult::ConversationUnavailable {}),
            (request, IdeResult::ConversationOpened {}),
        ]
        .into(),
    ));
    let DesktopHandoff::Stay(mut busy) =
        open_conversation(&mut client, session_id.clone(), thread_id.clone()).unwrap()
    else {
        panic!("busy must stay in terminal")
    };
    busy.localize(Language::Chinese);
    assert_eq!(
        busy.to_string(),
        "先完成或停止当前任务，并处理排队消息，再输入 /desktop。"
    );
    assert!(matches!(
        open_conversation(&mut client, session_id.clone(), thread_id.clone()).unwrap(),
        DesktopHandoff::Stay(_)
    ));
    assert!(matches!(
        open_conversation(&mut client, session_id, thread_id).unwrap(),
        DesktopHandoff::Opened
    ));
}

#[test]
fn desktop_handoff_error_keeps_the_terminal_and_does_not_retry_the_open() {
    struct FailedTransport;
    impl JsonRpcTransport for FailedTransport {
        fn round_trip(&mut self, _: &str) -> Result<String, ClientError> {
            Err(ClientError::Protocol("desktop navigation failed".into()))
        }
    }
    let mut client = AppServerClient::new(FailedTransport);
    assert!(
        open_conversation(
            &mut client,
            ash_protocol::SessionId::new("session").unwrap(),
            ash_protocol::ThreadId::new("thread").unwrap()
        )
        .is_err()
    );
}
