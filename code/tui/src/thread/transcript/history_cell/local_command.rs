use super::CellLines;
use super::CellMode;
use super::CellView;
use super::CommandStatus;
use super::HistoryCell;
use super::MessageRole;
use super::cache::ChatHistoryRenderCache;
use super::prefixed_body;
use crate::render::RenderContext;
use crate::thread::transcript::message_response::MessageResponse;
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
        width: u16,
    ) -> CellLines {
        let (marker, color) = if self.status == CommandStatus::Running {
            ("●", context.warning())
        } else {
            (">", context.muted())
        };
        let lines = prefixed_body(&self.command, marker, color, view, context, width);
        let input_rows = lines.len();
        let mut rendered = CellLines {
            hyperlinks: Vec::new(),
            lines,
            user_input_rows: input_rows,
            details_action: None,
        };
        if let Some(result) = &self.result {
            rendered.append_response(MessageResponse::ansi(result).layout(width, context));
        }
        rendered.finish(view, context, width)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LocalCommandCompletion {
    Immediate,
    Deferred,
}
