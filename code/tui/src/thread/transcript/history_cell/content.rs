use super::CellLines;
use super::CellMode;
use super::CellView;
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
pub(in crate::thread::transcript) struct ContentCell {
    pub(in crate::thread::transcript) role: MessageRole,
    pub(in crate::thread::transcript) text: String,
}

impl ContentCell {
    pub(in crate::thread::transcript) fn new(role: MessageRole, text: String) -> Self {
        Self { role, text }
    }
}

impl HistoryCell for ContentCell {
    fn role(&self) -> MessageRole {
        self.role
    }

    fn summary(&self, mode: CellMode) -> Cow<'_, str> {
        if mode == CellMode::History {
            return Cow::Borrowed(&self.text);
        }
        Cow::Borrowed(match self.role {
            MessageRole::Reasoning => "Thought",
            MessageRole::Error => self.text.lines().next().unwrap_or("Error"),
            _ => &self.text,
        })
    }

    fn detail(&self, mode: CellMode) -> Option<Cow<'_, str>> {
        (mode == CellMode::Expanded
            && matches!(self.role, MessageRole::Reasoning | MessageRole::Error))
        .then(|| Cow::Owned(bounded_preview(&self.text, 12)))
    }

    fn can_expand(&self) -> bool {
        matches!(self.role, MessageRole::Reasoning | MessageRole::Error)
            && (self.text.lines().count() > 1 || self.text.chars().count() > 120)
    }

    fn has_details(&self) -> bool {
        matches!(self.role, MessageRole::Reasoning | MessageRole::Error)
            && self.text.lines().count() > 12
    }

    fn full_details(&self) -> Option<String> {
        self.has_details().then(|| self.text.clone())
    }

    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        cache: Option<&ChatHistoryRenderCache>,
        width: u16,
    ) -> CellLines {
        let (marker, color) = match self.role {
            MessageRole::User => (">", context.muted()),
            MessageRole::Notice => ("●", context.warning()),
            MessageRole::Error => ("●", context.danger()),
            _ => ("●", context.muted()),
        };
        let rich = matches!(self.role, MessageRole::Agent | MessageRole::Plan);
        let (mut lines, hyperlinks) = if rich {
            let source = view.text();
            let mut highlight = |index, language: &str, code: &str| {
                if let Some(cache) = cache {
                    cache.highlight_code_block(
                        view.cell_id.as_deref(),
                        index,
                        language,
                        code,
                        context,
                    )
                } else {
                    crate::render::highlight_code(code, language, context.into())
                }
            };
            let body_width = usize::from(width.saturating_sub(2)).max(1);
            let mut rows = if let Some(cache) = cache {
                cache.markdown(
                    view.cell_id.as_deref(),
                    &source,
                    body_width,
                    context,
                    &mut highlight,
                )
            } else {
                super::super::streaming::StreamingRender::default().render(
                    "",
                    &source,
                    body_width,
                    context,
                    &mut highlight,
                )
            };
            if rows.is_empty() {
                rows.push(Default::default());
            }
            for (index, row) in rows.iter_mut().enumerate() {
                row.prefix(ratatui::text::Span::styled(
                    if index == 0 {
                        format!("{marker} ")
                    } else {
                        "  ".into()
                    },
                    ratatui::style::Style::default().fg(color),
                ));
                if view.selected {
                    let style = super::text::selected_style(true, context);
                    for span in row.line.spans.iter_mut().skip(1) {
                        span.style = span.style.patch(style);
                    }
                }
            }
            (
                rows.iter().map(|row| row.line.clone()).collect(),
                rows.into_iter().map(|row| row.links).collect(),
            )
        } else {
            (
                prefixed_body(&self.summary(view.mode), marker, color, view, context),
                Vec::new(),
            )
        };
        let input_lines = if self.role == MessageRole::User {
            lines.len()
        } else {
            0
        };
        if let Some(detail) = self.detail(view.mode) {
            push_detail_lines(&mut lines, DetailFormat::Plain, &detail, context);
        }
        let details_line = finish_lines(&mut lines, view, context);
        CellLines {
            wrapping: if rich {
                super::LineWrapping::Prewrapped
            } else {
                super::LineWrapping::Words
            },
            hyperlinks,
            lines,
            user_input_lines: input_lines,
            details_line,
        }
    }
}

fn bounded_preview(text: &str, max_lines: usize) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    if lines.len() <= max_lines {
        return text.to_owned();
    }
    let omitted = lines.len().saturating_sub(max_lines);
    format!(
        "{}\n… {omitted} lines omitted",
        lines[..max_lines].join("\n")
    )
}
