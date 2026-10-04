use super::CellLines;
use super::ChatHistoryRenderCache;
use super::MAX_CELL_CELLS;
use super::PreparedCell;
use crate::render::RenderTheme;
use crate::render::ThemePalette;
use crate::render::styled_text_lines;
use crate::render::test_context;
use crate::thread::transcript::CellView;
use crate::thread::transcript::MessageRole;
use ash_terminal_detection::ColorLevel;
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
            hyperlinks: Vec::new(),
            lines: crate::render::wrap_lines(
                styled_text_lines("cached text", Style::default()),
                20,
            ),
            user_input_rows: 0,
            details_action: None,
        }
    };

    let first = cache.prepare(&message(1), 20, test_context(), render);
    let second = cache.prepare(&message(1), 20, test_context(), render);

    assert!(matches!(first, PreparedCell::Buffered(_)));
    assert!(matches!(second, PreparedCell::Buffered(_)));
    assert_eq!(renders.get(), 1);
    assert_eq!(cache.buffered_entry_count(), 1);
}

#[test]
fn measuring_then_drawing_a_visible_cell_reuses_the_same_screen_rows() {
    let cache = ChatHistoryRenderCache::default();
    let message = message(1);
    let layouts = Cell::new(0);
    let render = || {
        layouts.set(layouts.get() + 1);
        message.lines(test_context(), Some(&cache), 20)
    };
    let measured = cache.measure(&message, 20, test_context(), render);
    assert_eq!(cache.buffered_entry_count(), 0);
    let first = cache.prepare(&message, 20, test_context(), render);
    let second = cache.prepare(&message, 20, test_context(), render);
    assert_eq!(layouts.get(), 1);
    assert!(matches!(first, PreparedCell::Buffered(_)));
    assert!(matches!(second, PreparedCell::Buffered(_)));
    assert_eq!(
        cache.measure(&message, 20, test_context(), render).height,
        measured.height
    );
    assert_eq!(layouts.get(), 1);
}

#[test]
fn measured_rows_and_screen_buffers_share_the_existing_cache_budget() {
    let cache = ChatHistoryRenderCache::default();
    for index in 0..super::MAX_CACHE_ENTRIES + 5 {
        let message = message(1).with_cell_id(format!("cell-{index}"));
        cache.measure(&message, 20, test_context(), || {
            message.lines(test_context(), Some(&cache), 20)
        });
    }
    let entries = cache.entries.borrow();
    assert!(entries.entries.len() <= super::MAX_CACHE_ENTRIES);
    assert!(entries.cells <= super::MAX_CACHE_CELLS);
    assert!(
        entries
            .entries
            .iter()
            .all(|entry| matches!(entry.cell, super::CachedCell::Rows(_)))
    );
    drop(entries);
    assert_eq!(cache.buffered_entry_count(), 0);
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
                &RenderTheme::from_palette(ThemePalette::initial(), ColorLevel::TrueColor),
                theme_revision,
            ),
            || {
                renders.set(renders.get() + 1);
                CellLines {
                    hyperlinks: Vec::new(),
                    lines: crate::render::wrap_lines(
                        styled_text_lines("cached text", Style::default()),
                        usize::from(width),
                    ),
                    user_input_rows: 0,
                    details_action: None,
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
    assert_eq!(cache.buffered_entry_count(), 1);
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
                hyperlinks: Vec::new(),
                lines: styled_text_lines("temporary", Style::default()),
                user_input_rows: 0,
                details_action: None,
            }
        });
    }

    assert_eq!(renders.get(), 2);
    assert_eq!(cache.buffered_entry_count(), 0);
}

#[test]
fn oversized_cells_are_rendered_without_entering_the_cache() {
    let cache = ChatHistoryRenderCache::default();
    let text = "x\n".repeat(MAX_CELL_CELLS / 20 + 1);
    let message = CellView::plain(MessageRole::Agent, text.clone())
        .with_cell_id("oversized")
        .with_render_revision(1);

    let prepared = cache.prepare(&message, 20, test_context(), || CellLines {
        hyperlinks: Vec::new(),
        lines: text
            .lines()
            .map(|line| ratatui::text::Line::from(line.to_owned()))
            .collect(),
        user_input_rows: 0,
        details_action: None,
    });

    assert!(matches!(prepared, PreparedCell::Lines { .. }));
    assert_eq!(cache.buffered_entry_count(), 0);
}

#[test]
fn language_change_rebuilds_rows_and_buffers_without_changing_the_message() {
    let cache = ChatHistoryRenderCache::default();
    let cell = CellView::plain(MessageRole::Error, "Error".into())
        .with_cell_id("localized-error")
        .with_render_revision(1);
    let area = ratatui::layout::Rect::new(0, 0, 16, 2);
    let english = test_context();
    cache.measure(&cell, 16, english, || cell.lines(english, Some(&cache), 16));
    cache.prepare(&cell, 16, english, || cell.lines(english, Some(&cache), 16));
    let chinese = test_context().with_language(crate::nls::Language::Chinese);
    let prepared = cache.prepare(&cell, 16, chinese, || cell.lines(chinese, Some(&cache), 16));
    let mut actual = ratatui::buffer::Buffer::empty(area);
    prepared.render(&mut actual, area, 0);
    let fresh = ChatHistoryRenderCache::default();
    let mut expected = ratatui::buffer::Buffer::empty(area);
    fresh
        .prepare(&cell, 16, chinese, || cell.lines(chinese, Some(&fresh), 16))
        .render(&mut expected, area, 0);
    assert_eq!(actual, expected);
    assert_eq!(actual[(2, 0)].symbol(), "错");
    assert_eq!(cell.text(), "Error");
}
