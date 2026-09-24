use super::CellLines;
use super::ChatHistoryRenderCache;
use super::MAX_CELL_CELLS;
use super::PreparedCell;
use crate::render::highlight_code;
use crate::render::styled_text_lines;
use crate::render::test_context;
use crate::thread::transcript::CellView;
use crate::thread::transcript::MessageRole;
use ratatui::style::Style;
use std::cell::Cell;

fn message(revision: u64) -> CellView<'static> {
    CellView::plain(MessageRole::Agent, "cached text".into())
        .with_cell_id("agent")
        .with_render_revision(revision)
}

#[test]
fn unchanged_cell_reuses_the_rendered_buffer() {
    let cache = ChatHistoryRenderCache::default();
    let renders = Cell::new(0);
    let render = || {
        renders.set(renders.get() + 1);
        CellLines {
            wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
            hyperlinks: Vec::new(),
            lines: styled_text_lines("cached text", Style::default()),
            user_input_lines: 0,
            details_line: None,
        }
    };

    let first = cache.prepare(&message(1), 20, test_context(), render);
    let second = cache.prepare(&message(1), 20, test_context(), render);

    assert!(matches!(first, PreparedCell::Buffered(_)));
    assert!(matches!(second, PreparedCell::Buffered(_)));
    assert_eq!(renders.get(), 1);
    assert_eq!(cache.entry_count(), 1);
}

#[test]
fn revision_width_theme_and_mode_replace_the_same_cell_entry() {
    let cache = ChatHistoryRenderCache::default();
    let renders = Cell::new(0);
    let prepare = |message: &CellView<'_>, width, theme_revision| {
        cache.prepare(
            message,
            width,
            crate::render::RenderContext::new(
                &crate::render::RenderTheme::fallback(),
                theme_revision,
            ),
            || {
                renders.set(renders.get() + 1);
                CellLines {
                    wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
                    hyperlinks: Vec::new(),
                    lines: styled_text_lines("cached text", Style::default()),
                    user_input_lines: 0,
                    details_line: None,
                }
            },
        )
    };

    prepare(&message(1), 20, 0);
    prepare(&message(2), 20, 0);
    prepare(&message(2), 10, 0);
    prepare(&message(2), 10, 1);
    let selected = message(2).with_presentation(false, true);
    prepare(&selected, 10, 1);

    assert_eq!(renders.get(), 5);
    assert_eq!(cache.entry_count(), 1);
}

#[test]
fn messages_without_a_content_revision_are_not_cached() {
    let cache = ChatHistoryRenderCache::default();
    let renders = Cell::new(0);
    let message = CellView::plain(MessageRole::Agent, "temporary".into());
    for _ in 0..2 {
        cache.prepare(&message, 20, test_context(), || {
            renders.set(renders.get() + 1);
            CellLines {
                wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
                hyperlinks: Vec::new(),
                lines: styled_text_lines("temporary", Style::default()),
                user_input_lines: 0,
                details_line: None,
            }
        });
    }

    assert_eq!(renders.get(), 2);
    assert_eq!(cache.entry_count(), 0);
}

#[test]
fn oversized_cells_are_rendered_without_entering_the_cache() {
    let cache = ChatHistoryRenderCache::default();
    let text = "x\n".repeat(MAX_CELL_CELLS / 20 + 1);
    let message = CellView::plain(MessageRole::Agent, text.clone())
        .with_cell_id("oversized")
        .with_render_revision(1);

    let prepared = cache.prepare(&message, 20, test_context(), || CellLines {
        wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
        hyperlinks: Vec::new(),
        lines: text
            .lines()
            .map(|line| ratatui::text::Line::from(line.to_owned()))
            .collect(),
        user_input_lines: 0,
        details_line: None,
    });

    assert!(matches!(prepared, PreparedCell::Lines { .. }));
    assert_eq!(cache.entry_count(), 0);
}

#[test]
fn transcript_code_blocks_reuse_incremental_parser_state() {
    let cache = ChatHistoryRenderCache::default();
    let context = test_context();
    let message = CellView::plain(MessageRole::Agent, String::new())
        .with_cell_id("streaming-agent")
        .with_render_revision(1);
    let first = "fn main() {\n";
    let complete = "fn main() {\n    let value = 1;\n}\n";

    cache.highlight_code_block(message.cell_id.as_deref(), 0, "rust", first, context);
    let rendered =
        cache.highlight_code_block(message.cell_id.as_deref(), 0, "rust", complete, context);

    assert_eq!(rendered, highlight_code(complete, "rust", context.into()));
}
