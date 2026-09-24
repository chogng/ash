use super::CONFIG_CHANGE;
use super::DISMISS_LIST;
use super::Keybinding;
use super::QUEUE_HINTS;
use super::SESSION_ARCHIVE;
use super::TAB_PREVIOUS;
use super::TABS;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionInputOutcome;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;

#[test]
fn a_panel_binding_drives_both_activation_and_hint_without_stealing_search_text() {
    let binding = Keybinding::new(&[(KeyModifiers::NONE, KeyCode::Char('r'))], "resume");
    let id = ListSelectionItemId::new("saved-session");
    let model = ListSelectionModel::new(
        "Resume",
        vec![ListSelectionGroup::new(
            "Sessions",
            vec![ListSelectionItem::new("review").with_id(id.clone())],
        )],
    )
    .with_activation(binding)
    .with_search(SearchBoxModel::new("Search"));
    assert_eq!(
        model.key_hints().text(),
        "r to resume  ·  Tab/Shift+Tab to switch  ·  / to search  ·  Esc to close"
    );
    let mut state = ListSelectionState::new(model);
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionInputOutcome::Consumed
    );
    for kind in [KeyEventKind::Repeat, KeyEventKind::Release] {
        assert_eq!(
            state.handle_key(KeyEvent::new_with_kind(
                KeyCode::Char('r'),
                KeyModifiers::NONE,
                kind
            )),
            ListSelectionInputOutcome::Consumed
        );
    }
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
        ListSelectionInputOutcome::Consumed
    );
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
        ListSelectionInputOutcome::Activate(id.clone())
    );
    state.focus_search();
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
        ListSelectionInputOutcome::Consumed
    );
    assert_eq!(state.query(), "r");
    state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
        ListSelectionInputOutcome::Activate(id)
    );
}

#[test]
fn binding_aliases_format_from_the_same_keys_and_require_exact_modifiers() {
    assert!(TAB_PREVIOUS.matches(KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE)));
    assert!(TAB_PREVIOUS.matches(KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT)));
    assert!(!TAB_PREVIOUS.matches(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::SHIFT | KeyModifiers::ALT
    )));
    assert_eq!(TABS.keys(), "Tab/Shift+Tab");
    assert_eq!(CONFIG_CHANGE.keys(), "Enter/Space");
    assert_eq!(SESSION_ARCHIVE.keys(), "Ctrl+X");
    assert!(DISMISS_LIST.matches(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));
    assert_eq!(
        KeyHints::new().with_binding(DISMISS_LIST).text(),
        "Esc to close"
    );
    assert_eq!(
        QUEUE_HINTS.text(),
        "Enter to edit · Ctrl+Enter to send now · Ctrl+↑/↓ to move · Delete to remove · Esc to return to input"
    );
}
