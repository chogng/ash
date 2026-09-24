use super::CellLines;
use super::CellMode;
use super::CellView;
use super::CommandStatus;
use super::DetailFormat;
use super::HistoryCell;
use super::MessageRole;
use super::cache::ChatHistoryRenderCache;
use super::finish_lines;
use super::prefixed_body;
use super::push_detail_lines;
use crate::render::RenderContext;
use std::borrow::Cow;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::thread::transcript) struct LocalCommandCell {
    pub(in crate::thread::transcript) command: String,
    pub(in crate::thread::transcript) result: Option<String>,
    pub(in crate::thread::transcript) status: CommandStatus,
}

impl HistoryCell for LocalCommandCell {
    fn role(&self) -> MessageRole {
        MessageRole::Command
    }
    fn summary(&self, _: CellMode) -> Cow<'_, str> {
        Cow::Borrowed(&self.command)
    }
    fn detail(&self, _: CellMode) -> Option<Cow<'_, str>> {
        self.result.as_deref().map(Cow::Borrowed)
    }

    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        _cache: Option<&ChatHistoryRenderCache>,
        _width: u16,
    ) -> CellLines {
        let (marker, color) = if self.status == CommandStatus::Running {
            ("●", context.warning())
        } else {
            (">", context.muted())
        };
        let mut lines = prefixed_body(&self.command, marker, color, view, context);
        let input_lines = lines.len();
        if let Some(result) = &self.result {
            push_detail_lines(&mut lines, DetailFormat::Ansi, result, context);
        }
        let details_line = finish_lines(&mut lines, view, context);
        CellLines {
            wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
            hyperlinks: Vec::new(),
            lines,
            user_input_lines: input_lines,
            details_line,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LocalCommandCompletion {
    Immediate,
    Deferred,
}
