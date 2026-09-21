use super::KeyHints;
use super::draw;
use super::draw_right;
use crate::config::KeyHintStyle;
use crate::render::test_context;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::Modifier;

fn visible(hints: &KeyHints, width: usize) -> String {
    let (entries, shortened) = super::visible_entries(hints, width, crate::nls::Language::English);
    super::visible_text(
        &entries,
        if shortened { " · " } else { hints.separator },
        crate::nls::Language::English,
    )
}

#[test]
fn narrow_hints_keep_the_exit_action_whole() {
    let hints = KeyHints::compact()
        .with_action("Enter/Space", "change")
        .with_action("↑↓/jk", "choose")
        .with_action("/", "search")
        .with_action("Tab", "switch")
        .with_action("Esc", "close");
    assert_eq!(
        visible(&hints, 76),
        "Enter/Space to change · / to search · Tab to switch · Esc to close"
    );
    assert_eq!(visible(&hints, 32), "Esc to close");
}

#[test]
fn key_hints_format_actions_and_notes_in_order() {
    let hints = KeyHints::new()
        .with_action("Enter", "apply")
        .with_note("current: dark")
        .with_action("Esc", "close");

    assert_eq!(
        hints.text(),
        "Enter to apply  ·  current: dark  ·  Esc to close"
    );
}

#[test]
fn key_hint_uses_two_character_horizontal_insets() {
    let backend = TestBackend::new(30, 1);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| {
            draw(
                frame,
                frame.area(),
                &KeyHints::new().with_action("Enter", "apply"),
                KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), " ");
    assert_eq!(buffer[(1, 0)].symbol(), " ");
    assert_eq!(buffer[(2, 0)].symbol(), "E");
}

#[test]
fn key_hint_styles_preserve_key_and_description_hierarchy() {
    let hints = KeyHints::new().with_compact_action("Shift+Tab", "mode");
    let mut contrast = Terminal::new(TestBackend::new(30, 1)).unwrap();
    contrast
        .draw(|frame| {
            draw(
                frame,
                frame.area(),
                &hints,
                KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();
    let buffer = contrast.backend().buffer();
    assert_eq!(buffer[(2, 0)].fg, test_context().foreground());
    assert!(buffer[(2, 0)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(11, 0)].fg, test_context().muted());
    assert!(!buffer[(11, 0)].modifier.contains(Modifier::BOLD));

    let mut muted = Terminal::new(TestBackend::new(30, 1)).unwrap();
    muted
        .draw(|frame| {
            draw(
                frame,
                frame.area(),
                &hints,
                KeyHintStyle::Muted,
                test_context(),
            )
        })
        .unwrap();
    let buffer = muted.backend().buffer();
    assert_eq!(buffer[(2, 0)].fg, test_context().muted());
    assert!(buffer[(2, 0)].modifier.contains(Modifier::ITALIC));
    assert_eq!(buffer[(11, 0)].fg, test_context().muted());
    assert!(buffer[(11, 0)].modifier.contains(Modifier::ITALIC));
}

#[test]
fn right_aligned_key_hint_keeps_the_two_character_right_inset() {
    let backend = TestBackend::new(30, 1);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| draw_right(frame, frame.area(), "← Dashboard", test_context()))
        .unwrap();

    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(17, 0)].symbol(), "←");
    assert_eq!(buffer[(27, 0)].symbol(), "d");
    assert_eq!(buffer[(28, 0)].symbol(), " ");
    assert_eq!(buffer[(29, 0)].symbol(), " ");
}
