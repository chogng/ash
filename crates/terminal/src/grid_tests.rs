use pretty_assertions::assert_eq;

use crate::{
    CursorKeyMode, GridSize, KeyModifiers, MouseEncoding, MouseTrackingMode, ScreenBuffer,
    TerminalColor, TerminalCore, TerminalKey,
};

#[test]
fn printable_text_wraps_and_scrolls_the_grid() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 4));
    terminal.process_output(b"abcdEF");

    assert_eq!(terminal.grid().lines()[0].text(), "abcd");
    assert_eq!(terminal.grid().lines()[1].text(), "EF");
    assert_eq!(terminal.grid().cursor(), (1, 2));
}

#[test]
fn carriage_return_and_erase_line_replace_visible_content() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 8));
    terminal.process_output(b"progress\r\x1b[2Kdone");

    assert_eq!(terminal.grid().lines()[0].text(), "done");
}

#[test]
fn cursor_addressing_and_sgr_update_cells() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 6));
    terminal.process_output(b"\x1b[2;3H\x1b[31;1mX");

    let cell = &terminal.grid().lines()[1].cells()[2];
    assert_eq!(cell.text(), "X");
    assert_eq!(cell.style().foreground, TerminalColor::Indexed(1));
    assert!(cell.style().bold);
}

#[test]
fn parser_state_survives_output_chunk_boundaries() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 8));
    terminal.process_output(b"\x1b[3");
    terminal.process_output(b"2mgreen");

    assert_eq!(
        terminal.grid().lines()[0].cells()[0].style().foreground,
        TerminalColor::Indexed(2)
    );
    assert_eq!(terminal.grid().lines()[0].text(), "green");
}

#[test]
fn printable_output_is_projected_into_the_active_block() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"$ ");
    terminal.start_command("printf hi");
    terminal.process_output(b"\x1b[32mhi\x1b[0m\r\n");

    assert_eq!(terminal.block_list().preamble(), "$ ");
    assert_eq!(terminal.block_list().blocks()[0].command(), "printf hi");
    assert_eq!(terminal.block_list().blocks()[0].output(), "hi\n");
}

#[test]
fn shell_integration_marker_completes_the_active_block() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.start_command("printf hi");
    terminal.process_output(b"hi\x1b]133;D;0\x07");

    assert_eq!(
        terminal.block_list().blocks()[0].status(),
        crate::BlockStatus::Completed
    );
    assert_eq!(terminal.block_list().blocks()[0].output(), "hi");
}

#[test]
fn wide_characters_occupy_two_cells() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 4));
    terminal.process_output("你a".as_bytes());

    assert_eq!(terminal.grid().lines()[0].cells()[0].text(), "你");
    assert!(terminal.grid().lines()[0].cells()[1].is_continuation());
    assert_eq!(terminal.grid().lines()[0].cells()[2].text(), "a");
}

#[test]
fn multilingual_text_preserves_script_content_and_cell_widths() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 24));
    terminal.process_output("中文 日本語 한국어".as_bytes());

    let line = &terminal.grid().lines()[0];
    assert_eq!(line.text(), "中文 日本語 한국어");
    assert_eq!(terminal.grid().cursor(), (0, 18));
    assert_eq!(
        line.cells()
            .iter()
            .filter(|cell| cell.is_continuation())
            .count(),
        8
    );
}

#[test]
fn extended_graphemes_remain_in_their_leading_cell() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 12));
    terminal.process_output("e\u{301} 👩‍💻 🇨🇳".as_bytes());

    let cells = terminal.grid().lines()[0].cells();
    assert_eq!(cells[0].text(), "e\u{301}");
    assert_eq!(cells[2].text(), "👩‍💻");
    assert!(cells[3].is_continuation());
    assert_eq!(cells[5].text(), "🇨🇳");
    assert!(cells[6].is_continuation());
    assert_eq!(terminal.grid().cursor(), (0, 7));
}

#[test]
fn alternate_screen_restores_primary_content_and_cursor() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 8));
    terminal.process_output(b"main\x1b[2;3H");

    terminal.process_output(b"\x1b[?1049halt");
    assert_eq!(terminal.active_screen(), ScreenBuffer::Alternate);
    assert_eq!(terminal.grid().lines()[0].text(), "alt");

    terminal.process_output(b"\x1b[?1049l");
    assert_eq!(terminal.active_screen(), ScreenBuffer::Primary);
    assert_eq!(terminal.grid().lines()[0].text(), "main");
    assert_eq!(terminal.grid().cursor(), (1, 2));
}

#[test]
fn alternate_screen_output_is_not_retained_in_command_blocks() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 16));
    terminal.start_command("vim");
    terminal.process_output(b"before\x1b[?1049hfullscreen\x1b[?1049lafter\n");

    assert_eq!(terminal.block_list().blocks()[0].output(), "beforeafter\n");
}

#[test]
fn dec_private_modes_project_input_and_pointer_state() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1;1002;1006;2004h\x1b[?25l");

    assert_eq!(terminal.modes().cursor_keys(), CursorKeyMode::Application);
    assert!(!terminal.modes().cursor_visible());
    assert!(terminal.modes().bracketed_paste());
    assert_eq!(
        terminal.modes().mouse_tracking(),
        MouseTrackingMode::ButtonEvent
    );
    assert_eq!(terminal.modes().mouse_encoding(), MouseEncoding::Sgr);

    terminal.process_output(b"\x1b[?1;1002;1006;2004l\x1b[?25h");
    assert_eq!(terminal.modes().cursor_keys(), CursorKeyMode::Normal);
    assert!(terminal.modes().cursor_visible());
    assert!(!terminal.modes().bracketed_paste());
    assert_eq!(
        terminal.modes().mouse_tracking(),
        MouseTrackingMode::Disabled
    );
    assert_eq!(terminal.modes().mouse_encoding(), MouseEncoding::Legacy);
}

#[test]
fn process_exit_returns_to_primary_screen_and_resets_modes() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"main\x1b[?1049hfullscreen\x1b[?1;2004h");

    terminal.mark_process_exited(1);

    assert_eq!(terminal.active_screen(), ScreenBuffer::Primary);
    assert_eq!(terminal.grid().lines()[0].text(), "main");
    assert_eq!(terminal.modes(), Default::default());
}

#[test]
fn public_input_encoding_follows_modes_parsed_from_output() {
    let mut terminal = TerminalCore::new(GridSize::default());

    assert_eq!(
        terminal.encode_key(TerminalKey::ArrowUp, KeyModifiers::NONE),
        b"\x1b[A"
    );
    assert_eq!(terminal.encode_paste("hello"), b"hello");

    terminal.process_output(b"\x1b[?1;2004h");
    assert_eq!(
        terminal.encode_key(TerminalKey::ArrowUp, KeyModifiers::NONE),
        b"\x1bOA"
    );
    assert_eq!(terminal.encode_paste("hello"), b"\x1b[200~hello\x1b[201~");
}

#[test]
fn scrolling_region_preserves_lines_outside_its_margins() {
    let mut terminal = TerminalCore::new(GridSize::new(5, 4));
    terminal.process_output(
        b"\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC\x1b[4;1HD\x1b[5;1HE\
          \x1b[2;4r\x1b[4;1H\n",
    );

    let lines = terminal
        .grid()
        .lines()
        .iter()
        .map(|line| line.text())
        .collect::<Vec<_>>();
    assert_eq!(lines, ["A", "C", "D", "", "E"]);
}

#[test]
fn insert_and_delete_lines_are_bounded_by_the_scrolling_region() {
    let initial = b"\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC\x1b[4;1HD\x1b[5;1HE\x1b[2;5r";

    let mut inserted = TerminalCore::new(GridSize::new(5, 4));
    inserted.process_output(initial);
    inserted.process_output(b"\x1b[3;1H\x1b[2L");
    assert_eq!(
        inserted
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["A", "B", "", "", "C"]
    );

    let mut deleted = TerminalCore::new(GridSize::new(5, 4));
    deleted.process_output(initial);
    deleted.process_output(b"\x1b[2;1H\x1b[2M");
    assert_eq!(
        deleted
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["A", "D", "E", "", ""]
    );
}

#[test]
fn origin_mode_addresses_and_reports_rows_relative_to_the_top_margin() {
    let mut terminal = TerminalCore::new(GridSize::new(5, 8));
    terminal.process_output(b"\x1b[2;4r\x1b[?6h\x1b[2;3H\x1b[6nX");

    assert_eq!(terminal.grid().lines()[2].cells()[2].text(), "X");
    assert_eq!(terminal.take_reply_bytes(), b"\x1b[2;3R");

    terminal.process_output(b"\x1b[?6l");
    assert_eq!(terminal.grid().cursor(), (0, 0));
}

#[test]
fn terminal_queries_generate_ordered_reply_bytes() {
    let mut terminal = TerminalCore::new(GridSize::new(5, 8));
    terminal.process_output(b"\x1b[5n\x1b[3;4H\x1b[6n\x1b[?6n\x1b[c\x1b[>c");

    assert_eq!(
        terminal.take_reply_bytes(),
        b"\x1b[0n\x1b[3;4R\x1b[?3;4R\x1b[?1;2c\x1b[>0;1;0c"
    );
    assert!(terminal.take_reply_bytes().is_empty());
}

#[test]
fn resizing_a_full_scrolling_region_extends_it_to_the_new_bottom_row() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 4));
    terminal.resize(GridSize::new(4, 4));
    terminal.process_output(b"\x1b[4;1HX\n");

    assert_eq!(terminal.grid().lines()[2].text(), "X");
    assert_eq!(terminal.grid().lines()[3].text(), "");
}

#[test]
fn full_screen_scroll_retains_cell_rows_for_scrollback() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 8));
    terminal.process_output(b"one\r\ntwo\r\nthree");

    assert_eq!(terminal.grid().scrollback_len(), 1);
    assert_eq!(terminal.grid().scrollback_lines()[0].text(), "one");
    assert_eq!(
        terminal
            .grid()
            .viewport_lines(1)
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["one", "two"]
    );
    assert_eq!(
        terminal
            .grid()
            .viewport_lines(0)
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["two", "three"]
    );
}

#[test]
fn partial_scroll_regions_and_alternate_screen_do_not_enter_scrollback() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 8));
    terminal.process_output(b"\x1b[2;3r\x1b[3;1Hbottom\n");
    assert_eq!(terminal.grid().scrollback_len(), 0);

    terminal.process_output(b"\x1b[?1049hfirst\r\nsecond\r\nthird\r\nfourth");
    assert_eq!(terminal.active_screen(), ScreenBuffer::Alternate);
    assert_eq!(terminal.grid().scrollback_len(), 0);

    terminal.process_output(b"\x1b[?1049l");
    assert_eq!(terminal.grid().scrollback_len(), 0);
}

#[test]
fn erase_saved_lines_clears_scrollback_without_erasing_the_screen() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 8));
    terminal.process_output(b"one\r\ntwo\r\nthree");
    assert_eq!(terminal.grid().scrollback_len(), 1);

    terminal.process_output(b"\x1b[3J");

    assert_eq!(terminal.grid().scrollback_len(), 0);
    assert_eq!(terminal.grid().lines()[0].text(), "two");
    assert_eq!(terminal.grid().lines()[1].text(), "three");
}

#[test]
fn primary_grid_reflows_wrapped_content_when_columns_change() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 6));
    terminal.process_output(b"abcdefghijkl");

    terminal.resize(GridSize::new(3, 4));

    assert_eq!(
        terminal
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["abcd", "efgh", "ijkl"]
    );
    assert_eq!(terminal.grid().cursor(), (2, 3));

    terminal.resize(GridSize::new(3, 6));
    assert_eq!(
        terminal
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["abcdef", "ghijkl", ""]
    );
    assert_eq!(terminal.grid().cursor(), (1, 5));
}

#[test]
fn reflow_keeps_older_wrapped_rows_in_scrollback() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 6));
    terminal.process_output(b"abcdefghijklmnop");

    terminal.resize(GridSize::new(2, 4));

    assert_eq!(
        terminal
            .grid()
            .scrollback_lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["abcd", "efgh"]
    );
    assert_eq!(
        terminal
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>(),
        ["ijkl", "mnop"]
    );
}

#[test]
fn alternate_screen_resize_does_not_create_or_reflow_scrollback() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 6));
    terminal.process_output(b"\x1b[?1049habcdef");

    terminal.resize(GridSize::new(2, 3));

    assert_eq!(terminal.grid().scrollback_len(), 0);
    assert_eq!(terminal.grid().lines()[0].text(), "abc");
    assert_eq!(terminal.grid().lines()[1].text(), "");
}

#[test]
fn reflow_moves_wide_characters_as_indivisible_cells() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 4));
    terminal.process_output("a你b".as_bytes());

    terminal.resize(GridSize::new(2, 2));

    assert_eq!(terminal.grid().scrollback_lines()[0].text(), "a");
    assert_eq!(terminal.grid().lines()[0].text(), "你");
    assert_eq!(terminal.grid().lines()[1].text(), "b");
}

#[test]
fn reflow_preserves_cell_styles() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 6));
    terminal.process_output(b"\x1b[31mabcdef");

    terminal.resize(GridSize::new(2, 3));

    for cell in terminal
        .grid()
        .lines()
        .iter()
        .flat_map(|line| line.cells())
        .filter(|cell| !cell.text().is_empty())
    {
        assert_eq!(cell.style().foreground, TerminalColor::Indexed(1));
    }
}

#[test]
fn widening_a_pending_wrap_places_the_cursor_after_the_content() {
    let mut terminal = TerminalCore::new(GridSize::new(2, 4));
    terminal.process_output(b"abcd");

    terminal.resize(GridSize::new(2, 6));
    terminal.process_output(b"e");

    assert_eq!(terminal.grid().lines()[0].text(), "abcde");
    assert_eq!(terminal.grid().cursor(), (0, 5));
}

#[test]
fn osc_zero_and_two_update_a_bounded_terminal_title() {
    let mut terminal = TerminalCore::new(GridSize::default());

    terminal.process_output(b"\x1b]0;project; shell\x07");
    assert_eq!(terminal.title(), Some("project; shell"));

    terminal.process_output(b"\x1b]2;editor\x1b\\");
    assert_eq!(terminal.title(), Some("editor"));

    terminal.process_output(b"\x1b]2;\x07");
    assert_eq!(terminal.title(), None);

    let long_title = format!("\x1b]2;{}\x07", "x".repeat(300));
    terminal.process_output(long_title.as_bytes());
    assert_eq!(terminal.title().unwrap().chars().count(), 256);
}

#[test]
fn terminal_core_filters_the_submitted_command_echo_from_block_output() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.start_command("echo hello");

    terminal.process_output(b"echo ");
    terminal.process_output(b"hello\r\nhello\r\n");

    assert_eq!(terminal.block_list().blocks()[0].output(), "hello\n");
}
