mod content;
mod local_command;
mod text;

use super::ChatHistoryRenderCache;
use super::markdown_cache::MarkdownCache;
pub(super) use content::ContentCell;
pub(super) use local_command::LocalCommandCell;
pub(crate) use local_command::LocalCommandCompletion;
pub(super) use text::prefixed_body;

use super::message_response::MessageResponse;
use super::message_response::ResponseAction;
use super::message_response::ResponseLayout;
use super::model::TranscriptCell;
use crate::render::RenderContext;
use ratatui::text::Line;
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

#[derive(Clone, Debug)]
pub(super) struct CellLayout {
    pub(super) height: usize,
    pub(super) details_action: Option<ResponseAction>,
}

/// Every row is already wrapped for the requested width. Measurement, input
/// backgrounds, actions and viewport offsets all use this one screen-row unit.
#[derive(Debug, Default)]
pub(super) struct CellLines {
    pub(super) lines: Vec<Line<'static>>,
    pub(super) hyperlinks: Vec<Vec<crate::render::links::Hyperlink>>,
    pub(super) user_input_rows: usize,
    pub(super) details_action: Option<ResponseAction>,
}

impl CellLines {
    pub(super) fn layout(&self) -> CellLayout {
        CellLayout {
            height: self.lines.len(),
            details_action: self.details_action.clone(),
        }
    }

    pub(super) fn append_response(&mut self, response: ResponseLayout) {
        if let Some(mut action) = response.details_action {
            for row in &mut action.rows {
                row.row += self.lines.len();
            }
            self.details_action = Some(action);
        }
        self.lines.extend(response.lines);
    }

    pub(super) fn finish(
        mut self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        width: u16,
    ) -> Self {
        if view.expanded && view.has_details {
            self.append_response(
                MessageResponse::styled(Vec::new())
                    .with_full_details_action()
                    .layout(width, context),
            );
        }
        self.lines.push(Line::default());
        self
    }
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
        cache: Option<&MarkdownCache>,
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
        if width == 0 {
            return CellLines::default();
        }
        self.owner().lines(
            self,
            context,
            cache.map(ChatHistoryRenderCache::markdown),
            width,
        )
    }
}
