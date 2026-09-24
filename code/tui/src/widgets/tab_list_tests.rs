use super::FocusedTabListInputOutcome;
use super::TabListInputOutcome;
use super::TabListItem;
use super::TabListState;
use super::desired_height;
use crate::render::test_context;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

#[derive(Clone, Debug, Eq, PartialEq)]
struct TestTab(&'static str);

impl TabListItem for TestTab {
    fn tab_label(&self) -> &str {
        self.0
    }
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn keyboard_navigation_switches_tabs_in_both_directions_and_wraps() {
    let mut tabs = TabListState::new(vec![TestTab("Overview"), TestTab("Providers")]);

    assert_eq!(
        tabs.handle_key(key(KeyCode::Right)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Providers");
    assert_eq!(
        tabs.handle_key(key(KeyCode::Left)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Overview");
    assert_eq!(
        tabs.handle_key(key(KeyCode::Tab)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Providers");
    assert_eq!(
        tabs.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Overview");
    assert_eq!(
        tabs.handle_key(key(KeyCode::Left)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Providers");
    assert_eq!(
        tabs.handle_key(key(KeyCode::Right)),
        TabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Overview");
}

#[test]
fn focused_tab_list_owns_switching_and_content_entry() {
    let mut tabs = TabListState::new(vec![TestTab("Overview"), TestTab("Providers")]);

    assert_eq!(
        tabs.handle_focused_key(key(KeyCode::Tab)),
        FocusedTabListInputOutcome::ActiveChanged
    );
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Providers");
    assert_eq!(
        tabs.handle_focused_key(key(KeyCode::Enter)),
        FocusedTabListInputOutcome::EnterContent
    );
    assert_eq!(
        tabs.handle_focused_key(key(KeyCode::Down)),
        FocusedTabListInputOutcome::FocusNext
    );
    assert_eq!(
        tabs.handle_focused_key(key(KeyCode::Up)),
        FocusedTabListInputOutcome::Unhandled
    );
}

#[test]
fn replacing_tabs_preserves_and_clamps_the_active_index() {
    let mut tabs = TabListState::new(vec![TestTab("One"), TestTab("Two"), TestTab("Three")]);
    tabs.handle_key(key(KeyCode::BackTab));

    tabs.replace_tabs(vec![TestTab("First"), TestTab("Second")]);

    assert_eq!(tabs.active_index(), Some(1));
    assert_eq!(tabs.active_tab().unwrap().tab_label(), "Second");
}

#[test]
fn narrow_width_wraps_tabs_without_hiding_them() {
    let tabs = vec![TestTab("Commands"), TestTab("Keys")];

    assert_eq!(desired_height(&tabs, 80), 1);
    assert_eq!(desired_height(&tabs, 12), 2);
}

#[test]
fn draw_keeps_the_active_tab_accent_surface_while_hovered() {
    let mut tabs = TabListState::new(vec![TestTab("One"), TestTab("Two")]);
    tabs.handle_key(key(KeyCode::Tab));
    let backend = TestBackend::new(20, 1);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| {
            super::draw(
                frame,
                frame.area(),
                &tabs,
                false,
                Some(1),
                None,
                test_context(),
            )
        })
        .unwrap();

    let active_label = &terminal.backend().buffer()[(8, 0)];
    assert_eq!(active_label.symbol(), "T");
    assert_eq!(active_label.fg, test_context().accent_surface_foreground());
    assert_eq!(active_label.bg, test_context().accent_surface_background());
}

#[test]
fn held_tab_does_not_skip_pages_and_shift_tab_moves_back() {
    let mut tabs = TabListState::new(vec![TestTab("One"), TestTab("Two"), TestTab("Three")]);
    tabs.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT));
    assert_eq!(tabs.active_index(), Some(2));
    for kind in [
        crossterm::event::KeyEventKind::Repeat,
        crossterm::event::KeyEventKind::Release,
    ] {
        tabs.handle_key(KeyEvent::new_with_kind(
            KeyCode::Tab,
            KeyModifiers::NONE,
            kind,
        ));
    }
    assert_eq!(tabs.active_index(), Some(2));
}

#[derive(Clone, Debug)]
struct AvailableTab {
    label: &'static str,
    enabled: bool,
}

impl TabListItem for AvailableTab {
    fn tab_label(&self) -> &str {
        self.label
    }

    fn tab_enabled(&self) -> bool {
        self.enabled
    }
}

fn available_tabs(enabled: [bool; 3]) -> Vec<AvailableTab> {
    ["One", "Two", "Three"]
        .into_iter()
        .zip(enabled)
        .map(|(label, enabled)| AvailableTab { label, enabled })
        .collect()
}

#[test]
fn disabled_tabs_are_skipped_in_both_directions_and_reject_direct_selection() {
    let mut tabs = TabListState::new(available_tabs([true, false, true]));
    for code in [
        KeyCode::Tab,
        KeyCode::Right,
        KeyCode::BackTab,
        KeyCode::Left,
    ] {
        tabs.select(0);
        assert_eq!(
            tabs.handle_key(key(code)),
            TabListInputOutcome::ActiveChanged
        );
        assert_eq!(tabs.active_index(), Some(2));
        assert_eq!(tabs.select(1), TabListInputOutcome::Unhandled);
        assert_eq!(tabs.active_index(), Some(2));
        tabs.handle_key(key(code));
        assert_eq!(tabs.active_index(), Some(0));
    }
}

#[test]
fn disabling_the_active_tab_reconciles_selection_and_all_disabled_has_no_content() {
    let mut tabs = TabListState::new(available_tabs([false, true, true]));
    assert_eq!(tabs.active_index(), Some(1));
    tabs.replace_tabs(available_tabs([true, false, true]));
    assert_eq!(tabs.active_index(), Some(2));
    tabs.replace_tabs(available_tabs([false, false, false]));
    assert!(tabs.active_tab().is_none());
    for code in [
        KeyCode::Tab,
        KeyCode::BackTab,
        KeyCode::Left,
        KeyCode::Right,
        KeyCode::Enter,
        KeyCode::Down,
    ] {
        assert_eq!(
            tabs.handle_focused_key(key(code)),
            FocusedTabListInputOutcome::Consumed
        );
        assert!(tabs.active_tab().is_none());
    }
    tabs.replace_tabs(available_tabs([false, true, false]));
    assert_eq!(tabs.active_index(), Some(1));
    assert_eq!(
        tabs.handle_key(key(KeyCode::Tab)),
        TabListInputOutcome::Consumed
    );
    assert_eq!(
        tabs.handle_focused_key(key(KeyCode::Enter)),
        FocusedTabListInputOutcome::EnterContent
    );
}

#[test]
fn disabled_tab_retains_its_label_without_hover_or_pressed_style() {
    let tabs = TabListState::new(available_tabs([true, false, true]));
    let mut terminal = Terminal::new(TestBackend::new(30, 1)).unwrap();
    terminal
        .draw(|frame| {
            super::draw(
                frame,
                frame.area(),
                &tabs,
                true,
                Some(1),
                Some(1),
                test_context(),
            )
        })
        .unwrap();
    let cell = &terminal.backend().buffer()[(8, 0)];
    assert_eq!(cell.symbol(), "T");
    assert_eq!(cell.fg, test_context().disabled_foreground());
    assert!(cell.modifier.contains(ratatui::style::Modifier::DIM));
    assert!(!cell.modifier.contains(ratatui::style::Modifier::BOLD));
}
