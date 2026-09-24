//! Monospace display-column mapping shared by text and decorations.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::TAB_WIDTH;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DisplayCellRun<'a> {
    pub text: &'a str,
    pub column: usize,
    pub columns: usize,
}

pub(super) fn display_columns(text: &str) -> usize {
    display_columns_until(text, text.len())
}

pub(super) fn display_columns_until(text: &str, byte_offset: usize) -> usize {
    let prefix = &text[..byte_offset.min(text.len())];
    let mut columns = 0;
    let mut segment_start = 0;
    for (index, character) in prefix.char_indices() {
        if character != '\t' {
            continue;
        }
        columns += UnicodeWidthStr::width(&prefix[segment_start..index]);
        columns += TAB_WIDTH - columns % TAB_WIDTH;
        segment_start = index + character.len_utf8();
    }
    columns + UnicodeWidthStr::width(&prefix[segment_start..])
}

pub(super) fn byte_offset_for_column(text: &str, requested: usize) -> usize {
    let mut best = 0;
    for (index, _) in text.char_indices() {
        if display_columns_until(text, index) > requested {
            break;
        }
        best = index;
    }
    if display_columns(text) <= requested {
        text.len()
    } else {
        best
    }
}

pub(super) fn expand_tabs(text: &str) -> String {
    expand_tabs_at_column(text, 0).0
}

pub(super) fn expand_tabs_at_column(text: &str, start_column: usize) -> (String, usize) {
    let mut expanded = String::with_capacity(text.len());
    let mut columns = start_column;
    let mut segment_start = 0;
    for (index, character) in text.char_indices() {
        if character != '\t' {
            continue;
        }
        let segment = &text[segment_start..index];
        expanded.push_str(segment);
        columns += UnicodeWidthStr::width(segment);
        let spaces = TAB_WIDTH - columns % TAB_WIDTH;
        expanded.extend(std::iter::repeat_n(' ', spaces));
        columns += spaces;
        segment_start = index + character.len_utf8();
    }
    let tail = &text[segment_start..];
    expanded.push_str(tail);
    columns += UnicodeWidthStr::width(tail);
    (expanded, columns)
}

pub(super) fn has_wide_display_cells(text: &str) -> bool {
    text.graphemes(true)
        .any(|grapheme| display_columns(grapheme) > 1)
}

pub(super) fn visit_display_cell_runs<'a>(
    text: &'a str,
    mut visit: impl FnMut(DisplayCellRun<'a>),
) -> usize {
    if text.is_empty() {
        return 0;
    }
    if text
        .graphemes(true)
        .all(|grapheme| display_columns(grapheme) <= 1)
    {
        let columns = display_columns(text);
        if columns > 0 {
            visit(DisplayCellRun {
                text,
                column: 0,
                columns,
            });
        }
        return columns;
    }

    let mut run_start = 0;
    let mut run_column = 0;
    let mut column = 0;
    for (start, grapheme) in text.grapheme_indices(true) {
        let grapheme_columns = display_columns(grapheme);
        let isolate = grapheme_columns != 1 || grapheme.chars().all(char::is_whitespace);
        if !isolate {
            column += grapheme_columns;
            continue;
        }
        visit_run(
            &mut visit,
            &text[run_start..start],
            run_column,
            column - run_column,
        );
        if !grapheme.chars().all(char::is_whitespace) {
            visit_run(&mut visit, grapheme, column, grapheme_columns);
        }
        column += grapheme_columns;
        run_start = start + grapheme.len();
        run_column = column;
    }
    visit_run(
        &mut visit,
        &text[run_start..],
        run_column,
        column - run_column,
    );
    column
}

fn visit_run<'a>(
    visit: &mut impl FnMut(DisplayCellRun<'a>),
    text: &'a str,
    column: usize,
    columns: usize,
) {
    if text.is_empty() || columns == 0 {
        return;
    }
    visit(DisplayCellRun {
        text,
        column,
        columns,
    });
}
