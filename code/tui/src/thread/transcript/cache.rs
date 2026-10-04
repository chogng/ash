use super::CellView;
use super::history_cell::CellLayout;
use super::history_cell::CellLines;
use crate::render::RenderContext;
use crate::render::line_to_borrowed;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;

const MAX_CACHE_ENTRIES: usize = 256;
const MAX_CACHE_CELLS: usize = 250_000;
const MAX_CELL_CELLS: usize = 65_536;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CellRenderMode {
    Normal,
    Selected,
    Expanded,
    ExpandedSelected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CacheKey {
    cell_id: String,
    render_revision: u64,
    visible_source_end: Option<usize>,
    width: u16,
    theme_revision: u64,
    language: crate::nls::Language,
    preview_revision: u64,
    mode: CellRenderMode,
}

impl CacheKey {
    fn for_cell(cell: &CellView<'_>, width: u16, context: RenderContext<'_>) -> Option<Self> {
        let cell_id = cell.cell_id.clone()?;
        if cell.render_revision == 0 {
            return None;
        }
        let mode = match (cell.expanded, cell.selected) {
            (false, false) => CellRenderMode::Normal,
            (false, true) => CellRenderMode::Selected,
            (true, false) => CellRenderMode::Expanded,
            (true, true) => CellRenderMode::ExpandedSelected,
        };
        Some(Self {
            cell_id,
            render_revision: cell.render_revision,
            visible_source_end: cell.visible_source_end,
            width,
            theme_revision: context.theme_revision(),
            language: context.language(),
            preview_revision: context.preview_revision(),
            mode,
        })
    }
}

#[derive(Debug)]
struct CacheEntry {
    key: CacheKey,
    cell: CachedCell,
    cost: usize,
}

#[derive(Debug)]
enum CachedCell {
    Rows(Box<CellLines>),
    Buffered(Arc<RenderedCell>),
}

#[derive(Debug)]
struct LayoutEntry {
    key: CacheKey,
    layout: CellLayout,
}

#[derive(Debug, Default)]
struct CacheEntries {
    entries: VecDeque<CacheEntry>,
    cells: usize,
}

#[derive(Debug, Default)]
pub(crate) struct ChatHistoryRenderCache {
    entries: RefCell<CacheEntries>,
    layouts: RefCell<HashMap<String, LayoutEntry>>,
    markdown: super::markdown_cache::MarkdownCache,
}

impl ChatHistoryRenderCache {
    pub(crate) fn retain_cells(&self, messages: &[CellView<'_>]) {
        let ids = messages
            .iter()
            .filter_map(|cell| cell.cell_id.as_ref())
            .collect::<HashSet<_>>();
        self.layouts
            .borrow_mut()
            .retain(|cell_id, _| ids.contains(cell_id));
        let mut entries = self.entries.borrow_mut();
        entries
            .entries
            .retain(|entry| ids.contains(&entry.key.cell_id));
        entries.cells = entries.entries.iter().map(|entry| entry.cost).sum();
        self.markdown.retain(&ids);
    }

    pub(in crate::thread::transcript) fn measure(
        &self,
        cell: &CellView<'_>,
        width: u16,
        context: RenderContext<'_>,
        render: impl FnOnce() -> CellLines,
    ) -> CellLayout {
        let key = CacheKey::for_cell(cell, width, context);
        if let Some(key) = key.as_ref()
            && let Some(height) = self.cached_layout(key)
        {
            return height;
        }
        let rendered = render();
        let height = rendered.layout();
        if let Some(key) = key {
            self.insert_layout(key.clone(), height.clone());
            // Keep rows within the existing cell budget until a visible cell needs
            // its buffer. Measuring offscreen records must not allocate screen buffers.
            if let Some(cost) = usize::from(width).checked_mul(height.height)
                && cost <= MAX_CELL_CELLS
            {
                self.insert(key, CachedCell::Rows(Box::new(rendered)), cost);
            }
        }
        height
    }

    pub(in crate::thread::transcript) fn prepare(
        &self,
        cell: &CellView<'_>,
        width: u16,
        context: RenderContext<'_>,
        render: impl FnOnce() -> CellLines,
    ) -> PreparedCell {
        let key = CacheKey::for_cell(cell, width, context);
        let stored = key.as_ref().and_then(|key| self.take(key));
        let rendered = match stored {
            Some(CachedCell::Buffered(cell)) => {
                let cost =
                    usize::from(cell.buffer.area.width) * usize::from(cell.buffer.area.height);
                self.insert(
                    key.expect("a cached cell has a key"),
                    CachedCell::Buffered(Arc::clone(&cell)),
                    cost,
                );
                return PreparedCell::Buffered(cell);
            }
            Some(CachedCell::Rows(rows)) => *rows,
            None => render(),
        };
        let layout = rendered.layout();
        let height = layout.height;
        let CellLines {
            lines,
            user_input_rows,
            hyperlinks,
            ..
        } = rendered;
        if let Some(key) = key.as_ref() {
            self.insert_layout(key.clone(), layout);
        }
        let Some(cost) = usize::from(width).checked_mul(height) else {
            return PreparedCell::Lines {
                foreground: context.foreground(),
                hyperlinks,
                lines,
                background: context.background(),
                user_input_background: context.user_message_background(),
                user_input_rows,
            };
        };
        let Some(buffer_height) = u16::try_from(height).ok() else {
            return PreparedCell::Lines {
                foreground: context.foreground(),
                hyperlinks,
                lines,
                background: context.background(),
                user_input_background: context.user_message_background(),
                user_input_rows,
            };
        };
        if key.is_none() || cost > MAX_CELL_CELLS {
            return PreparedCell::Lines {
                foreground: context.foreground(),
                hyperlinks,
                lines,
                background: context.background(),
                user_input_background: context.user_message_background(),
                user_input_rows,
            };
        }

        let area = Rect::new(0, 0, width, buffer_height);
        let mut buffer = Buffer::empty(area);
        buffer.set_style(
            area,
            Style::default()
                .fg(context.foreground())
                .bg(context.background()),
        );
        fill_user_input_background(
            &mut buffer,
            area,
            0,
            user_input_rows,
            context.user_message_background(),
        );
        Paragraph::new(lines).render(area, &mut buffer);
        let cell = Arc::new(RenderedCell { buffer, hyperlinks });
        self.insert(
            key.expect("cacheable messages have a key"),
            CachedCell::Buffered(Arc::clone(&cell)),
            cost,
        );
        PreparedCell::Buffered(cell)
    }

    fn take(&self, key: &CacheKey) -> Option<CachedCell> {
        let mut cache = self.entries.borrow_mut();
        let index = cache.entries.iter().position(|entry| entry.key == *key)?;
        let entry = cache
            .entries
            .remove(index)
            .expect("the matching cache entry exists");
        cache.cells -= entry.cost;
        Some(entry.cell)
    }

    fn cached_layout(&self, key: &CacheKey) -> Option<CellLayout> {
        self.layouts
            .borrow()
            .get(&key.cell_id)
            .filter(|entry| entry.key == *key)
            .map(|entry| entry.layout.clone())
    }

    fn insert_layout(&self, key: CacheKey, layout: CellLayout) {
        self.layouts
            .borrow_mut()
            .insert(key.cell_id.clone(), LayoutEntry { key, layout });
    }

    pub(crate) fn clear(&self) {
        *self.entries.borrow_mut() = CacheEntries::default();
        self.layouts.borrow_mut().clear();
        self.markdown.clear();
    }

    pub(super) fn markdown(&self) -> &super::markdown_cache::MarkdownCache {
        &self.markdown
    }

    fn insert(&self, key: CacheKey, cell: CachedCell, cost: usize) {
        let mut cache = self.entries.borrow_mut();
        if let Some(index) = cache
            .entries
            .iter()
            .position(|entry| entry.key.cell_id == key.cell_id)
            && let Some(removed) = cache.entries.remove(index)
        {
            cache.cells = cache.cells.saturating_sub(removed.cost);
        }
        cache.cells = cache.cells.saturating_add(cost);
        cache.entries.push_back(CacheEntry { key, cell, cost });
        while cache.entries.len() > MAX_CACHE_ENTRIES || cache.cells > MAX_CACHE_CELLS {
            let Some(removed) = cache.entries.pop_front() else {
                break;
            };
            cache.cells = cache.cells.saturating_sub(removed.cost);
        }
    }

    #[cfg(test)]
    pub(crate) fn buffered_entry_count(&self) -> usize {
        self.entries
            .borrow()
            .entries
            .iter()
            .filter(|entry| matches!(entry.cell, CachedCell::Buffered(_)))
            .count()
    }
}

pub(crate) enum PreparedCell {
    Buffered(Arc<RenderedCell>),
    Lines {
        foreground: Color,
        hyperlinks: Vec<Vec<crate::render::links::Hyperlink>>,
        lines: Vec<Line<'static>>,
        background: Color,
        user_input_background: Color,
        user_input_rows: usize,
    },
}

impl PreparedCell {
    pub(crate) fn place_links(
        &self,
        links: &mut crate::render::links::FrameLinks,
        area: Rect,
        source_row: usize,
    ) {
        let rows = match self {
            Self::Buffered(cell) => &cell.hyperlinks,
            Self::Lines { hyperlinks, .. } => hyperlinks,
        };
        links.place(rows, area, source_row);
    }

    pub(crate) fn render(&self, target: &mut Buffer, area: Rect, source_row: usize) {
        match self {
            Self::Buffered(cell) => cell.render(target, area, source_row),
            Self::Lines {
                lines,
                foreground,
                background,
                user_input_background,
                user_input_rows,
                ..
            } => {
                target.set_style(area, Style::default().fg(*foreground).bg(*background));
                fill_user_input_background(
                    target,
                    area,
                    source_row,
                    *user_input_rows,
                    *user_input_background,
                );
                let lines = lines[source_row.min(lines.len())..]
                    .iter()
                    .take(usize::from(area.height))
                    .map(line_to_borrowed)
                    .collect::<Vec<_>>();
                Paragraph::new(lines).render(area, target);
            }
        }
    }
}

fn fill_user_input_background(
    target: &mut Buffer,
    area: Rect,
    source_row: usize,
    user_input_rows: usize,
    background: Color,
) {
    let Some(visible_rows) = user_input_rows
        .checked_sub(source_row)
        .map(|rows| rows.min(usize::from(area.height)))
        .and_then(|rows| u16::try_from(rows).ok())
        .filter(|rows| *rows > 0)
    else {
        return;
    };
    target.set_style(
        Rect::new(area.x, area.y, area.width, visible_rows),
        Style::default().bg(background),
    );
}

#[derive(Debug)]
pub(crate) struct RenderedCell {
    buffer: Buffer,
    hyperlinks: Vec<Vec<crate::render::links::Hyperlink>>,
}

impl RenderedCell {
    fn render(&self, target: &mut Buffer, area: Rect, source_row: usize) {
        let width = area.width.min(self.buffer.area.width);
        for row in 0..area.height {
            let source_y = source_row.saturating_add(usize::from(row));
            if source_y >= usize::from(self.buffer.area.height) {
                break;
            }
            let source_y = source_y as u16;
            for column in 0..width {
                let Some(source) = self.buffer.cell((column, source_y)) else {
                    continue;
                };
                if let Some(destination) =
                    target.cell_mut((area.x.saturating_add(column), area.y.saturating_add(row)))
                {
                    *destination = source.clone();
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
