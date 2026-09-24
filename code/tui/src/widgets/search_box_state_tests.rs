use super::SearchBoxInputOutcome;
use super::SearchBoxModel;
use super::SearchBoxState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn search_box() -> SearchBoxState {
    SearchBoxState::new(SearchBoxModel::new("Search available skills"))
}

#[test]
fn search_box_is_visible_but_not_input_active_by_default() {
    let search = search_box();

    assert_eq!(search.placeholder(), "Search available skills");
    assert_eq!(search.query(), "");
    assert!(!search.input_active());
}

#[test]
fn owner_focus_controls_when_text_changes_the_query() {
    let mut search = search_box();

    assert_eq!(
        search.handle_key(key(KeyCode::Char(' '))),
        SearchBoxInputOutcome::Ignored
    );
    search.set_input_active(true);
    assert!(search.input_active());
    assert_eq!(search.query(), "");
    assert_eq!(
        search.handle_key(key(KeyCode::Char(' '))),
        SearchBoxInputOutcome::QueryChanged
    );
    assert_eq!(search.query(), " ");
}

#[test]
fn text_and_paste_only_change_a_focused_search() {
    let mut search = search_box();

    assert_eq!(
        search.handle_key(key(KeyCode::Char('s'))),
        SearchBoxInputOutcome::Ignored
    );
    assert_eq!(
        search.handle_paste("status".into()),
        SearchBoxInputOutcome::Ignored
    );
    search.set_input_active(true);
    search.handle_key(key(KeyCode::Char('s')));
    search.handle_paste("how\nstatus".into());

    assert_eq!(search.query(), "show status");
}

#[test]
fn escape_is_left_for_the_owning_view() {
    let mut search = search_box();
    search.set_input_active(true);
    search.handle_key(key(KeyCode::Char('s')));

    assert_eq!(
        search.handle_key(key(KeyCode::Esc)),
        SearchBoxInputOutcome::Ignored
    );
    assert_eq!(search.query(), "s");
    assert!(search.input_active());
}

#[test]
fn arrows_edit_unicode_text_and_paste_at_the_cursor() {
    let mut search = search_box();
    search.set_input_active(true);
    search.handle_paste("界ab".into());
    search.handle_key(key(KeyCode::Left));
    search.handle_key(key(KeyCode::Left));
    search.handle_key(key(KeyCode::Backspace));
    search.handle_key(key(KeyCode::Char('中')));
    search.handle_key(key(KeyCode::Right));
    search.handle_paste("文".into());
    assert_eq!(search.query(), "中a文b");
}
