//! Terminal history viewport tests.

use super::{block_view_range, scroll_limit, visible_text_lines};
use ash_terminal::{GridSize, TerminalCore};

#[test]
fn block_history_uses_the_same_range_for_scroll_limit_and_visible_text() {
    let mut terminal = TerminalCore::new(GridSize::new(3, 16));
    terminal.start_command("history");
    terminal.process_output(b"one\ntwo\nthree\nfour\n");

    assert_eq!(scroll_limit(&terminal, 3), 2);
    assert_eq!(block_view_range(5, 3, 0), 2..5);
    assert_eq!(
        visible_text_lines(&terminal, 3, 2),
        ["❯ history", "one", "two"]
    );
}
