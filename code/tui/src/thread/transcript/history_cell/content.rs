use super::CellLines;
use super::CellMode;
use super::CellView;
use super::HistoryCell;
use super::MessageRole;
use super::prefixed_body;
use crate::render::RenderContext;
use crate::thread::transcript::markdown_cache::MarkdownCache;
use crate::thread::transcript::message_response::MessageResponse;
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

    fn preview(&self, mode: CellMode, language: crate::nls::Language) -> Option<Cow<'_, str>> {
        if self.role == MessageRole::Reasoning && self.text.trim().is_empty() {
            return None;
        }
        match (self.role, mode) {
            (MessageRole::Reasoning, CellMode::Collapsed) => {
                let mut text = self.text.chars().take(240).collect::<String>();
                if self.text.chars().count() > 240 {
                    text.push('…');
                }
                Some(Cow::Owned(bounded_preview(&text, 3, language)))
            }
            (MessageRole::Reasoning | MessageRole::Error, CellMode::Expanded) => {
                Some(Cow::Owned(bounded_preview(&self.text, 12, language)))
            }
            _ => None,
        }
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
            MessageRole::Reasoning => "Reasoning summary",
            MessageRole::Error => self.text.lines().next().unwrap_or("Error"),
            _ => &self.text,
        })
    }

    fn detail(&self, mode: CellMode) -> Option<Cow<'_, str>> {
        self.preview(mode, crate::nls::Language::English)
    }

    fn can_expand(&self) -> bool {
        match self.role {
            MessageRole::Reasoning => {
                self.text.lines().count() > 3 || self.text.chars().count() > 240
            }
            MessageRole::Error => self.text.lines().count() > 1 || self.text.chars().count() > 120,
            _ => false,
        }
    }

    fn has_details(&self) -> bool {
        match self.role {
            MessageRole::Reasoning => {
                self.text.lines().count() > 3 || self.text.chars().count() > 240
            }
            MessageRole::Error => self.text.lines().count() > 12,
            _ => false,
        }
    }

    fn full_details(&self) -> Option<String> {
        self.has_details().then(|| self.text.clone())
    }

    fn lines(
        &self,
        view: &CellView<'_>,
        context: RenderContext<'_>,
        cache: Option<&MarkdownCache>,
        width: u16,
    ) -> CellLines {
        if self.role == MessageRole::Reasoning && self.text.trim().is_empty() {
            return CellLines::default();
        }
        let (marker, color) = match self.role {
            MessageRole::User => (">", context.muted()),
            MessageRole::Notice => ("●", context.warning()),
            MessageRole::Error => ("●", context.danger()),
            _ => ("●", context.muted()),
        };
        let rich = matches!(self.role, MessageRole::Agent | MessageRole::Plan);
        let (lines, hyperlinks) = if rich {
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
            let gutter_width = crate::render::prefix_width(usize::from(width), 2);
            let body_width = usize::from(width) - gutter_width;
            let mut rows = if let Some((cache, id)) = cache.zip(view.cell_id.as_deref()) {
                cache.render(id, &source, body_width, context, &mut highlight)
            } else {
                MarkdownCache::default().render("", &source, body_width, context, &mut highlight)
            };
            if rows.is_empty() {
                rows.push(Default::default());
            }
            for (index, row) in rows.iter_mut().enumerate() {
                row.prefix(ratatui::text::Span::styled(
                    crate::render::truncate_to_width(
                        &if index == 0 {
                            format!("{marker} ")
                        } else {
                            "  ".into()
                        },
                        gutter_width,
                    ),
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
            let summary = self.summary(view.mode);
            // Product titles and stable backend errors use NLS keys; the model's
            // summary body remains verbatim when the display language changes.
            let summary = if self.role == MessageRole::Error
                || (self.role == MessageRole::Reasoning && view.mode != CellMode::History)
            {
                crate::nls::localize(context.language(), &summary)
            } else {
                Cow::Borrowed(summary.as_ref())
            };
            (
                prefixed_body(&summary, marker, color, view, context, width),
                Vec::new(),
            )
        };
        let input_rows = if self.role == MessageRole::User {
            lines.len()
        } else {
            0
        };
        let mut rendered = CellLines {
            hyperlinks,
            lines,
            user_input_rows: input_rows,
            details_action: None,
        };
        if let Some(detail) = self.preview(view.mode, context.language()) {
            let response = MessageResponse::plain(&detail);
            let response = if view.mode == CellMode::Collapsed && view.has_details {
                response.with_full_details_action()
            } else {
                response
            };
            rendered.append_response(response.layout(width, context));
        }
        rendered.finish(view, context, width)
    }
}

fn bounded_preview(text: &str, max_lines: usize, language: crate::nls::Language) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    if lines.len() <= max_lines {
        return text.to_owned();
    }
    let omitted = lines.len().saturating_sub(max_lines);
    let mut marker = crate::nls::Text::template(
        "… {0} more lines",
        vec![crate::nls::Text::literal(omitted.to_string())],
    );
    marker.localize(language);
    let marker = marker.to_string();
    format!("{}\n{marker}", lines[..max_lines].join("\n"))
}
