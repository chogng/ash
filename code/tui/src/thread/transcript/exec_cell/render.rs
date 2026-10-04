use super::ExecCell;
use super::truncate_utf8;
use crate::render::RenderContext;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::history_cell::CellLines;
use crate::thread::transcript::history_cell::CellMode;
use crate::thread::transcript::history_cell::CellView;
use crate::thread::transcript::history_cell::ChatHistoryRenderCache;
use crate::thread::transcript::history_cell::DETAIL_PREFIX;
use crate::thread::transcript::history_cell::DetailFormat;
use crate::thread::transcript::history_cell::HistoryCell;
use crate::thread::transcript::history_cell::MessageRole;
use crate::thread::transcript::history_cell::finish_lines;
use crate::thread::transcript::history_cell::prefixed_body;
use crate::thread::transcript::history_cell::push_detail_lines;
use ash_ansi_escape::ansi_text;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::borrow::Cow;

const EXPANDED_LINES: usize = 12;

impl HistoryCell for ExecCell {
    fn role(&self) -> MessageRole {
        MessageRole::Command
    }
    fn summary(&self, _: CellMode) -> Cow<'_, str> {
        Cow::Owned(self.summary(crate::nls::Language::English))
    }
    fn detail(&self, mode: CellMode) -> Option<Cow<'_, str>> {
        match mode {
            CellMode::Collapsed => None,
            CellMode::Expanded => Some(Cow::Owned(first_lines(
                &self.full_details(),
                EXPANDED_LINES,
            ))),
            CellMode::History => Some(Cow::Owned(self.full_details())),
        }
    }
    fn can_expand(&self) -> bool {
        self.can_expand()
    }
    fn has_details(&self) -> bool {
        self.has_details()
    }
    fn full_details(&self) -> Option<String> {
        self.has_details().then(|| self.full_details())
    }
    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        _cache: Option<&ChatHistoryRenderCache>,
        _width: u16,
    ) -> CellLines {
        let color = match self.status() {
            CommandStatus::Submitted | CommandStatus::Running => context.warning(),
            CommandStatus::Failed if self.calls.len() > 1 => context.muted(),
            CommandStatus::Failed => context.danger(),
            CommandStatus::Succeeded => context.muted(),
        };
        let mut lines = prefixed_body(&self.summary(context.language()), "●", color, view, context);
        if view.mode == CellMode::Collapsed {
            for call in self.calls.iter().filter(|call| call.failed) {
                let label = call.failure_label(context.language());
                let reason = call
                    .result
                    .as_deref()
                    .and_then(|result| {
                        ansi_text(result)
                            .lines
                            .into_iter()
                            .map(|line| line.to_string())
                            .find(|line| !line.trim().is_empty())
                    })
                    .map(|line| truncate_utf8(&line, 160));
                let mut spans = vec![
                    Span::styled(DETAIL_PREFIX, Style::default().fg(context.muted())),
                    Span::styled(label, Style::default().fg(context.danger())),
                ];
                if let Some(reason) = reason {
                    spans.push(Span::styled(
                        format!(" — {reason}"),
                        Style::default().fg(context.muted()),
                    ));
                }
                lines.push(Line::from(spans));
            }
        }
        if let Some(detail) = self.detail(view.mode) {
            push_detail_lines(&mut lines, DetailFormat::Ansi, &detail, context);
        }
        let details_line = finish_lines(&mut lines, view, context);
        CellLines {
            wrapping: crate::thread::transcript::history_cell::LineWrapping::Words,
            hyperlinks: Vec::new(),
            lines,
            user_input_lines: 0,
            details_line,
        }
    }
}

fn first_lines(text: &str, limit: usize) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    if lines.len() <= limit {
        return text.to_owned();
    }
    let omitted = lines.len().saturating_sub(limit);
    format!(
        "{}\n… {omitted} lines omitted; view full",
        lines[..limit].join("\n")
    )
}
