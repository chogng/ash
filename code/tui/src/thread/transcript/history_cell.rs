mod cache;
mod content;
mod local_command;
mod text;

pub(crate) use cache::ChatHistoryRenderCache;
pub(super) use content::ContentCell;
pub(super) use local_command::LocalCommandCell;
pub(crate) use local_command::LocalCommandCompletion;
pub(super) use text::prefixed_body;
pub(super) use text::push_detail_lines;

use super::model::TranscriptCell;
use crate::render::RenderContext;
use crate::render::action_style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MessageRole {
    User,
    Agent,
    Reasoning,
    Plan,
    Command,
    Notice,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandStatus {
    Submitted,
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum CellMode {
    #[default]
    Collapsed,
    Expanded,
    History,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct CellLayout {
    pub(super) height: usize,
    pub(super) details_row: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum LineWrapping {
    Words,
    Prewrapped,
}

pub(super) struct CellLines {
    pub(super) wrapping: LineWrapping,
    pub(super) lines: Vec<Line<'static>>,
    pub(super) hyperlinks: Vec<Vec<crate::terminal::hyperlinks::Hyperlink>>,
    pub(super) user_input_lines: usize,
    pub(super) details_line: Option<usize>,
}

impl CellLines {
    fn line_height(&self, lines: &[Line<'_>], width: u16) -> usize {
        match self.wrapping {
            LineWrapping::Words => crate::render::wrapped_height(lines, width),
            LineWrapping::Prewrapped => lines.len(),
        }
    }

    pub(super) fn layout(&self, width: u16) -> CellLayout {
        CellLayout {
            height: self.line_height(&self.lines, width),
            details_row: self
                .details_line
                .map(|line| self.line_height(&self.lines[..line], width)),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum DetailFormat {
    Plain,
    Ansi,
}

/// A concrete transcript item owns its text, display lines and expansion behavior.
/// The transcript composes these outputs without interpreting tool or message fields.
pub(super) trait HistoryCell: std::fmt::Debug {
    fn role(&self) -> MessageRole;
    fn summary(&self, mode: CellMode) -> Cow<'_, str>;
    fn detail(&self, mode: CellMode) -> Option<Cow<'_, str>>;
    fn can_expand(&self) -> bool {
        false
    }
    fn has_details(&self) -> bool {
        false
    }
    fn full_details(&self) -> Option<String> {
        None
    }
    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        cache: Option<&ChatHistoryRenderCache>,
        width: u16,
    ) -> CellLines;
}

#[derive(Clone, Debug)]
pub(crate) struct CellView<'a> {
    pub(super) cell: Cow<'a, TranscriptCell>,
    pub(crate) cell_id: Option<String>,
    pub(crate) render_revision: u64,
    pub(super) visible_source_end: Option<usize>,
    pub(crate) can_expand: bool,
    pub(crate) expanded: bool,
    pub(crate) has_details: bool,
    pub(crate) selected: bool,
    pub(super) mode: CellMode,
}

impl CellView<'_> {
    pub(crate) fn height(
        &self,
        width: u16,
        context: RenderContext<'_>,
        cache: &ChatHistoryRenderCache,
    ) -> usize {
        cache
            .measure(self, width, context, || {
                self.lines(context, Some(cache), width)
            })
            .height
    }

    pub(crate) fn render_rows(
        &self,
        buffer: &mut ratatui::buffer::Buffer,
        offset: usize,
        context: RenderContext<'_>,
        cache: &ChatHistoryRenderCache,
    ) {
        let area = buffer.area;
        let prepared = cache.prepare(self, area.width, context, || {
            self.lines(context, Some(cache), area.width)
        });
        prepared.render(buffer, area, offset);
        if let Some(links) = context.hyperlinks() {
            prepared.place_links(&mut links.borrow_mut(), area, offset);
        }
    }

    pub(super) fn owner(&self) -> &dyn HistoryCell {
        self.cell.history_cell()
    }
    pub(crate) fn text(&self) -> Cow<'_, str> {
        let text = self.owner().summary(self.mode);
        match (text, self.visible_source_end) {
            (Cow::Borrowed(text), Some(end)) => Cow::Borrowed(&text[..end]),
            (Cow::Owned(mut text), Some(end)) => {
                text.truncate(end);
                Cow::Owned(text)
            }
            (text, None) => text,
        }
    }
    pub(crate) fn detail(&self) -> Option<Cow<'_, str>> {
        self.owner().detail(self.mode)
    }
    pub(crate) fn role(&self) -> MessageRole {
        self.owner().role()
    }
    pub(super) fn lines(
        &self,
        context: RenderContext<'_>,
        cache: Option<&ChatHistoryRenderCache>,
        width: u16,
    ) -> CellLines {
        self.owner().lines(self, context, cache, width)
    }
}

pub(super) fn finish_lines(
    lines: &mut Vec<Line<'static>>,
    view: &CellView<'_>,
    context: RenderContext<'_>,
) -> Option<usize> {
    let details_line = (view.expanded && view.has_details).then_some(lines.len());
    if view.expanded && view.has_details {
        lines.push(Line::from(Span::styled(
            "   view full",
            action_style(context),
        )));
    }
    lines.push(Line::default());
    details_line
}
