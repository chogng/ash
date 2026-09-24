use super::draw;
use crate::render::test_context;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::search_box::SearchBoxState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Position;

#[test]
fn active_empty_search_keeps_the_cursor_clear_of_the_left_border() {
    let search = SearchBoxState::new(SearchBoxModel::new("Search").initially_active());
    let backend = TestBackend::new(30, 3);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| draw(frame, frame.area(), &search, false, false, test_context()))
        .unwrap();

    terminal
        .backend_mut()
        .assert_cursor_position(Position::new(2, 1));
}

#[test]
fn active_search_places_the_terminal_cursor_after_the_query() {
    let mut search = SearchBoxState::new(SearchBoxModel::new("Search").initially_active());
    search.handle_key(KeyEvent::new(KeyCode::Char('界'), KeyModifiers::NONE));
    search.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
    let backend = TestBackend::new(30, 3);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| draw(frame, frame.area(), &search, false, false, test_context()))
        .unwrap();

    terminal
        .backend_mut()
        .assert_cursor_position(Position::new(5, 1));
}

#[test]
fn left_arrow_moves_the_rendered_cursor_before_a_wide_character() {
    let mut search = SearchBoxState::new(SearchBoxModel::new("Search").initially_active());
    search.handle_paste("a界".into());
    search.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    let mut terminal = Terminal::new(TestBackend::new(30, 3)).unwrap();
    terminal
        .draw(|frame| draw(frame, frame.area(), &search, false, false, test_context()))
        .unwrap();
    terminal
        .backend_mut()
        .assert_cursor_position(Position::new(3, 1));
}

#[test]
fn masked_search_renders_bullets_without_exposing_the_query() {
    let mut search =
        SearchBoxState::new(SearchBoxModel::new("API key").initially_active().masked());
    search.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE));
    search.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE));
    let backend = TestBackend::new(20, 3);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| draw(frame, frame.area(), &search, false, false, test_context()))
        .unwrap();

    let rendered = terminal.backend().to_string();
    assert!(rendered.contains("••"));
    assert!(!rendered.contains("sk"));
    let debug = format!("{search:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("query: \"sk\""));
}

#[test]
fn search_box_distinguishes_focus_hover_and_pressed_borders() {
    let search = SearchBoxState::new(SearchBoxModel::new("Search"));
    let backend = TestBackend::new(20, 3);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| draw(frame, frame.area(), &search, true, false, test_context()))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        test_context().foreground()
    );
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].bg,
        ratatui::style::Color::Reset
    );

    terminal
        .draw(|frame| draw(frame, frame.area(), &search, true, true, test_context()))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        test_context().pressed_foreground()
    );

    let active = SearchBoxState::new(SearchBoxModel::new("Search").initially_active());
    terminal
        .draw(|frame| draw(frame, frame.area(), &active, false, false, test_context()))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        test_context().focus()
    );
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), "╭");
    assert_eq!(buffer[(19, 0)].symbol(), "╮");
    assert_eq!(buffer[(0, 2)].symbol(), "╰");
    assert_eq!(buffer[(19, 2)].symbol(), "╯");
}
