use super::*;
use crate::app::App;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::widgets::list_selection::ListSelectionState;

#[test]
fn ide_picker_keeps_window_names_verbatim_and_localizes_actions() {
    let window = IdeWindow {
        id: "12345678901234567890123456789012".into(),
        title: "My project".into(),
        roots: vec!["/project".into()],
    };
    let mut view = choices(std::slice::from_ref(&window), Some(&window));
    view.model.localize(Language::Chinese);
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.title(), "Ash IDE");
    assert_eq!(
        view.actions.get(&ListSelectionItemId::new(&window.id)),
        Some(&Command::Connect(window.id))
    );
    assert_eq!(
        crate::nls::localize(Language::Chinese, "Disconnect IDE"),
        "断开 IDE"
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
    app.update(Event::Opened(choices(std::slice::from_ref(&window), None)));
    assert_eq!(app.list_selection().unwrap().title(), "Ash IDE");
    assert!(
        matches!(app.handle_key(KeyEvent::new(crossterm::event::KeyCode::Enter, crossterm::event::KeyModifiers::NONE)), Some(crate::app::AppCommand::Ide(Command::Connect(id))) if id == window.id)
    );
    app.update(Event::Opened(choices(&[], None)));
    app.handle_key(KeyEvent::new(
        crossterm::event::KeyCode::Esc,
        crossterm::event::KeyModifiers::NONE,
    ));
    assert!(app.list_selection().is_none());
}
