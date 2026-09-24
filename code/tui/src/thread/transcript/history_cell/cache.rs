use super::CellLayout;
use super::CellLines;
use super::CellView;
use super::LineWrapping;
use crate::render::RenderContext;
use crate::render::StreamingCodeHighlighter;
use crate::render::code_within_limits;
use crate::render::highlight_code;
use crate::render::line_to_borrowed;
use crate::render::wrapped_height;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use ratatui::widgets::Wrap;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;

const MAX_CACHE_ENTRIES: usize = 256;
const MAX_CACHE_CELLS: usize = 250_000;
const MAX_CELL_CELLS: usize = 65_536;
const MAX_CODE_BLOCKS: usize = 64;
const MAX_CODE_SOURCE_BYTES: usize = 2 * 1024 * 1024;

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
            mode,
        })
    }
}

#[derive(Debug)]
struct CacheEntry {
    key: CacheKey,
    cell: Arc<RenderedCell>,
    cost: usize,
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
    code_blocks: RefCell<CodeBlockEntries>,
    markdown: RefCell<super::super::streaming::StreamingRender>,
}

#[derive(Debug, Default)]
struct CodeBlockEntries {
    entries: VecDeque<CodeBlockEntry>,
    source_bytes: usize,
}

#[derive(Debug)]
struct CodeBlockEntry {
    key: (String, usize),
    render: CodeBlockRender,
}

#[derive(Debug)]
struct CodeBlockRender {
    language: String,
    theme_revision: u64,
    complete_source: String,
    complete_lines: Vec<Line<'static>>,
    highlighter: Option<StreamingCodeHighlighter>,
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
        self.code_blocks.borrow_mut().retain(&ids);
        self.markdown.borrow_mut().retain(&ids);
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
        let height = render().layout(width);
        if let Some(key) = key {
            self.insert_layout(key, height);
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
        if let Some(key) = key.as_ref()
            && let Some(cell) = self.cached(key)
        {
            return PreparedCell::Buffered(cell);
        }

        let rendered = render();
        let layout = rendered.layout(width);
        let height = layout.height;
        let CellLines {
            wrapping,
            lines,
            user_input_lines,
            hyperlinks,
            ..
        } = rendered;
        let user_input_rows = wrapped_height(&lines[..user_input_lines.min(lines.len())], width);
        if let Some(key) = key.as_ref() {
            self.insert_layout(key.clone(), layout);
        }
        let Some(cost) = usize::from(width).checked_mul(height) else {
            return PreparedCell::Lines {
                wrapping,
                hyperlinks,
                lines,
                background: context.background(),
                user_input_background: context.user_message_background(),
                user_input_rows,
            };
        };
        let Some(buffer_height) = u16::try_from(height).ok() else {
            return PreparedCell::Lines {
                wrapping,
                hyperlinks,
                lines,
                background: context.background(),
                user_input_background: context.user_message_background(),
                user_input_rows,
            };
        };
        if key.is_none() || cost > MAX_CELL_CELLS {
            return PreparedCell::Lines {
                wrapping,
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
        let paragraph = Paragraph::new(lines);
        let paragraph = match wrapping {
            LineWrapping::Words => paragraph.wrap(Wrap { trim: false }),
            LineWrapping::Prewrapped => paragraph,
        };
        paragraph.render(area, &mut buffer);
        let cell = Arc::new(RenderedCell { buffer, hyperlinks });
        self.insert(
            key.expect("cacheable messages have a key"),
            Arc::clone(&cell),
            cost,
        );
        PreparedCell::Buffered(cell)
    }

    fn cached(&self, key: &CacheKey) -> Option<Arc<RenderedCell>> {
        let mut cache = self.entries.borrow_mut();
        let index = cache.entries.iter().position(|entry| entry.key == *key)?;
        let entry = cache
            .entries
            .remove(index)
            .expect("the matching cache entry exists");
        let cell = Arc::clone(&entry.cell);
        cache.entries.push_back(entry);
        Some(cell)
    }

    fn cached_layout(&self, key: &CacheKey) -> Option<CellLayout> {
        self.layouts
            .borrow()
            .get(&key.cell_id)
            .filter(|entry| entry.key == *key)
            .map(|entry| entry.layout)
    }

    fn insert_layout(&self, key: CacheKey, layout: CellLayout) {
        self.layouts
            .borrow_mut()
            .insert(key.cell_id.clone(), LayoutEntry { key, layout });
    }

    pub(crate) fn clear(&self) {
        *self.entries.borrow_mut() = CacheEntries::default();
        self.layouts.borrow_mut().clear();
        *self.code_blocks.borrow_mut() = CodeBlockEntries::default();
        *self.markdown.borrow_mut() = Default::default();
    }

    pub(crate) fn markdown(
        &self,
        id: Option<&str>,
        source: &str,
        width: usize,
        context: RenderContext<'_>,
        highlight: &mut impl FnMut(usize, &str, &str) -> Vec<Line<'static>>,
    ) -> Vec<crate::terminal::hyperlinks::HyperlinkLine> {
        if let Some(id) = id {
            self.markdown
                .borrow_mut()
                .render(id, source, width, context, highlight)
        } else {
            super::super::streaming::StreamingRender::default()
                .render("", source, width, context, highlight)
        }
    }

    pub(crate) fn highlight_code_block(
        &self,
        cell_id: Option<&str>,
        block_index: usize,
        language: &str,
        source: &str,
        context: RenderContext<'_>,
    ) -> Vec<Line<'static>> {
        let Some(cell_id) = cell_id else {
            return highlight_code(source, language, context.into());
        };
        let key = (cell_id.to_owned(), block_index);
        let mut blocks = self.code_blocks.borrow_mut();
        if !code_within_limits(source) {
            blocks.remove(&key);
            return highlight_code(source, language, context.into());
        }
        let mut block = blocks
            .take(&key)
            .unwrap_or_else(|| CodeBlockRender::new(language, source, context));
        let lines = block.update(language, source, context);
        blocks.insert(key, block);
        lines
    }

    fn insert(&self, key: CacheKey, cell: Arc<RenderedCell>, cost: usize) {
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
    pub(crate) fn entry_count(&self) -> usize {
        self.entries.borrow().entries.len()
    }
}

impl CodeBlockEntries {
    fn retain(&mut self, cell_ids: &HashSet<&String>) {
        self.entries.retain(|entry| cell_ids.contains(&entry.key.0));
        self.source_bytes = self
            .entries
            .iter()
            .map(|entry| entry.render.complete_source.len())
            .sum();
    }

    fn take(&mut self, key: &(String, usize)) -> Option<CodeBlockRender> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self
            .entries
            .remove(index)
            .expect("the matching code block entry exists");
        self.source_bytes = self
            .source_bytes
            .saturating_sub(entry.render.complete_source.len());
        Some(entry.render)
    }

    fn remove(&mut self, key: &(String, usize)) {
        let _ = self.take(key);
    }

    fn insert(&mut self, key: (String, usize), render: CodeBlockRender) {
        self.source_bytes = self
            .source_bytes
            .saturating_add(render.complete_source.len());
        self.entries.push_back(CodeBlockEntry { key, render });
        while self.entries.len() > MAX_CODE_BLOCKS || self.source_bytes > MAX_CODE_SOURCE_BYTES {
            let Some(entry) = self.entries.pop_front() else {
                break;
            };
            self.source_bytes = self
                .source_bytes
                .saturating_sub(entry.render.complete_source.len());
        }
    }
}

impl CodeBlockRender {
    fn new(language: &str, source: &str, context: RenderContext<'_>) -> Self {
        let (complete, _) = complete_source(source);
        let (highlighter, complete_lines) = StreamingCodeHighlighter::start(
            complete,
            language,
            context.into(),
            context.theme_revision(),
        )
        .expect("a complete code prefix is accepted by the streaming highlighter");
        Self {
            language: language.to_owned(),
            theme_revision: context.theme_revision(),
            complete_source: complete.to_owned(),
            complete_lines,
            highlighter: Some(highlighter),
        }
    }

    fn update(
        &mut self,
        language: &str,
        source: &str,
        context: RenderContext<'_>,
    ) -> Vec<Line<'static>> {
        let (complete, partial) = complete_source(source);
        let reusable = self.language == language
            && self.theme_revision == context.theme_revision()
            && complete.starts_with(&self.complete_source);
        if reusable && complete.len() > self.complete_source.len() {
            let appended = &complete[self.complete_source.len()..];
            let highlighter = self
                .highlighter
                .take()
                .expect("code block render state owns its highlighter");
            if let Some((highlighter, lines)) =
                highlighter.append(appended, context.into(), context.theme_revision())
            {
                self.highlighter = Some(highlighter);
                self.complete_source.push_str(appended);
                self.complete_lines.extend(lines);
            } else {
                let replacement = StreamingCodeHighlighter::start(
                    complete,
                    language,
                    context.into(),
                    context.theme_revision(),
                )
                .expect("a complete code prefix is accepted by the streaming highlighter");
                self.replace(language, complete, context, replacement);
            }
        } else if !reusable || complete.len() < self.complete_source.len() {
            let replacement = StreamingCodeHighlighter::start(
                complete,
                language,
                context.into(),
                context.theme_revision(),
            )
            .expect("a complete code prefix is accepted by the streaming highlighter");
            self.replace(language, complete, context, replacement);
        }

        if !partial.is_empty() {
            return highlight_code(source, language, context.into());
        }
        let mut lines = self.complete_lines.clone();
        if lines.is_empty() {
            lines.push(Line::default());
        }
        lines
    }

    fn replace(
        &mut self,
        language: &str,
        complete: &str,
        context: RenderContext<'_>,
        replacement: (StreamingCodeHighlighter, Vec<Line<'static>>),
    ) {
        self.language = language.to_owned();
        self.theme_revision = context.theme_revision();
        self.complete_source = complete.to_owned();
        self.highlighter = Some(replacement.0);
        self.complete_lines = replacement.1;
    }
}

fn complete_source(source: &str) -> (&str, &str) {
    let complete_len = source.rfind('\n').map_or(0, |index| index + 1);
    source.split_at(complete_len)
}

pub(crate) enum PreparedCell {
    Buffered(Arc<RenderedCell>),
    Lines {
        wrapping: LineWrapping,
        hyperlinks: Vec<Vec<crate::terminal::hyperlinks::Hyperlink>>,
        lines: Vec<Line<'static>>,
        background: Color,
        user_input_background: Color,
        user_input_rows: usize,
    },
}

impl PreparedCell {
    pub(crate) fn place_links(
        &self,
        links: &mut crate::terminal::hyperlinks::FrameLinks,
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
                wrapping,
                lines,
                background,
                user_input_background,
                user_input_rows,
                ..
            } => {
                target.set_style(area, Style::default().bg(*background));
                fill_user_input_background(
                    target,
                    area,
                    source_row,
                    *user_input_rows,
                    *user_input_background,
                );
                let (lines, source_row) = match wrapping {
                    LineWrapping::Words => visible_lines(lines, area.width, source_row),
                    LineWrapping::Prewrapped => (&lines[source_row.min(lines.len())..], 0),
                };
                let lines = lines.iter().map(line_to_borrowed).collect::<Vec<_>>();
                let paragraph = Paragraph::new(lines).scroll((source_row, 0));
                let paragraph = match wrapping {
                    LineWrapping::Words => paragraph.wrap(Wrap { trim: false }),
                    LineWrapping::Prewrapped => paragraph,
                };
                paragraph.render(area, target);
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
    hyperlinks: Vec<Vec<crate::terminal::hyperlinks::Hyperlink>>,
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

fn visible_lines<'a>(
    lines: &'a [Line<'static>],
    width: u16,
    mut source_row: usize,
) -> (&'a [Line<'static>], u16) {
    let mut first = 0;
    while first < lines.len() {
        let height = wrapped_height(std::slice::from_ref(&lines[first]), width);
        if source_row < height {
            break;
        }
        source_row -= height;
        first += 1;
    }
    (
        &lines[first..],
        source_row.min(usize::from(u16::MAX)) as u16,
    )
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
