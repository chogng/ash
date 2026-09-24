//! Markdown syntax and width-aware terminal presentation, independent of transcript state.

mod table;

use crate::render::RenderContext;
use crate::terminal::hyperlinks::HyperlinkLine;
use crate::terminal::hyperlinks::wrap;
use pulldown_cmark::CodeBlockKind;
use pulldown_cmark::Event;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use pulldown_cmark::TagEnd;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::ops::Range;
use unicode_width::UnicodeWidthStr;

pub(crate) struct MarkdownBlock<'a> {
    pub(crate) source: Range<usize>,
    events: Vec<(Event<'a>, bool)>,
}

/// Parse as a complete document so late reference definitions can resolve earlier links.
/// Top-level blocks are the reuse unit; a list or table remains one indivisible block.
pub(crate) fn blocks(source: &str) -> Vec<MarkdownBlock<'_>> {
    let parser = Parser::new_ext(
        source,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    );
    let references = parser.reference_definitions().iter().next().is_some();
    let mut result = Vec::new();
    let mut events = Vec::new();
    let mut start = 0;
    let mut end = 0;
    let mut depth = 0usize;
    let mut code_text_end = 0;
    for (event, range) in parser.into_offset_iter() {
        if events.is_empty() {
            start = range.start;
        }
        end = range.end;
        match &event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
        let closed = match &event {
            Event::Start(Tag::CodeBlock(_)) => {
                code_text_end = range.start;
                false
            }
            Event::Text(_) => {
                code_text_end = range.end;
                false
            }
            // The parser's block range consumes a real closing fence beyond the final Text
            // range. An EOF-generated End event has no such suffix, including in containers.
            Event::End(TagEnd::CodeBlock) => source[code_text_end..range.end]
                .trim_end()
                .ends_with(['`', '~']),
            _ => false,
        };
        events.push((event, closed));
        if depth == 0 && !references {
            result.push(MarkdownBlock {
                source: start..end,
                events: std::mem::take(&mut events),
            });
        }
    }
    if !events.is_empty() {
        result.push(MarkdownBlock {
            source: if references {
                0..source.len()
            } else {
                start..end
            },
            events,
        });
    }
    result
}

pub(crate) fn render(
    block: &MarkdownBlock<'_>,
    width: usize,
    context: RenderContext<'_>,
    highlight: &mut impl FnMut(usize, &str, &str) -> Vec<Line<'static>>,
) -> Vec<HyperlinkLine> {
    let mut writer = Writer {
        width: width.max(1),
        context,
        rows: Vec::new(),
        current: HyperlinkLine::default(),
        styles: vec![Style::default()],
        link: None,
        lists: Vec::new(),
        list_widths: Vec::new(),
        quote: 0,
        item_prefix: None,
        code: None,
        table: None,
        code_index: block.source.start,
    };
    for (event, closed) in &block.events {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                writer.flush();
                let language = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or(""),
                    _ => "",
                };
                writer.code = Some((language.to_owned(), String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((language, source)) = writer.code.take() {
                    let diagram = if *closed && language == "mermaid" {
                        mermaid::render(&source, writer.available_width()).ok()
                    } else {
                        None
                    };
                    let lines = match diagram {
                        Some(rows) => rows
                            .into_iter()
                            .map(|row| Line::styled(row, Style::default().fg(context.r#type())))
                            .collect(),
                        None => {
                            highlight(writer.code_index, &language, &source.replace('\t', "    "))
                        }
                    };
                    for line in lines {
                        writer.current = HyperlinkLine {
                            line,
                            links: Vec::new(),
                        };
                        if writer.current.line.spans.is_empty() {
                            writer.current.line.push_span(Span::raw(""));
                        }
                        writer.flush();
                    }
                    writer.code_index += 1;
                }
            }
            Event::Text(text) if writer.code.is_some() => {
                writer.code.as_mut().unwrap().1.push_str(text);
            }
            Event::Start(Tag::Table(alignments)) => {
                writer.flush();
                writer.table = Some(table::Table::new(alignments.clone()));
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {
                if let Some(table) = &mut writer.table {
                    table.start_row();
                }
            }
            Event::Start(Tag::TableCell) => {
                writer.current = HyperlinkLine::default();
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(table) = &mut writer.table {
                    table.push(std::mem::take(&mut writer.current));
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some(table) = writer.table.take() {
                    for row in table.render(writer.available_width(), context) {
                        writer.current = row;
                        if writer.current.line.spans.is_empty() {
                            writer.current.line.push_span(Span::raw(""));
                        }
                        writer.flush();
                    }
                }
            }
            Event::Start(Tag::Heading { .. }) => {
                writer.flush();
                writer.push_style(Modifier::BOLD);
            }
            Event::End(TagEnd::Heading(_)) => {
                writer.flush();
                writer.styles.pop();
            }
            Event::Start(Tag::Paragraph) => {
                writer.flush();
            }
            Event::End(TagEnd::Paragraph) => {
                writer.flush();
            }
            Event::Start(Tag::BlockQuote(_)) => {
                writer.flush();
                writer.quote += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                writer.flush();
                writer.quote = writer.quote.saturating_sub(1);
            }
            Event::Start(Tag::List(start)) => {
                writer.flush();
                writer.lists.push(*start);
                writer.list_widths.push(2);
            }
            Event::End(TagEnd::List(_)) => {
                writer.flush();
                writer.lists.pop();
                writer.list_widths.pop();
            }
            Event::Start(Tag::Item) => {
                writer.flush();
                let marker = match writer.lists.last_mut() {
                    Some(Some(number)) => {
                        let marker = format!("{number}. ");
                        *number += 1;
                        marker
                    }
                    _ => "• ".to_owned(),
                };
                if let Some(width) = writer.list_widths.last_mut() {
                    *width = marker.width();
                }
                writer.item_prefix = Some(marker);
            }
            Event::End(TagEnd::Item) => {
                writer.flush();
                writer.item_prefix = None;
            }
            Event::Start(Tag::Emphasis) => writer.push_style(Modifier::ITALIC),
            Event::Start(Tag::Strong) => writer.push_style(Modifier::BOLD),
            Event::Start(Tag::Strikethrough) => writer.push_style(Modifier::CROSSED_OUT),
            Event::End(TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough) => {
                writer.styles.pop();
            }
            Event::Start(Tag::Link { dest_url, .. })
            | Event::Start(Tag::Image { dest_url, .. }) => {
                writer.link = Some(dest_url.to_string());
                writer.push_style(Modifier::UNDERLINED);
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                // Local destinations remain visible and copyable; arbitrary file URLs are not
                // promoted to executable terminal links.
                if let Some(target) = writer.link.take()
                    && crate::terminal::hyperlinks::web_destination(&target).is_none()
                {
                    writer.text(&format!(" ({target})"));
                }
                writer.styles.pop();
            }
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => writer.text(text),
            Event::Code(text) => {
                let style = writer.style().fg(context.accent());
                writer.current.push(text, style, writer.link.as_deref());
            }
            Event::SoftBreak => {
                if writer.table.is_some() {
                    writer.text(" ");
                } else {
                    writer.flush();
                }
            }
            Event::HardBreak => {
                if writer.table.is_some() {
                    writer.text(" / ");
                } else {
                    writer.flush();
                }
            }
            Event::Rule => {
                writer.flush();
                writer.text(&"─".repeat(writer.available_width()));
                writer.flush();
            }
            Event::TaskListMarker(checked) => {
                if let Some(prefix) = writer.item_prefix.as_mut() {
                    let number = prefix.strip_suffix("• ").unwrap_or(prefix).to_owned();
                    *prefix = format!("{number}{} ", if *checked { "☑" } else { "☐" });
                    if let Some(width) = writer.list_widths.last_mut() {
                        *width = prefix.width();
                    }
                    if writer.current.line.spans.is_empty() {
                        writer.current.line.push_span(Span::raw(""));
                    }
                }
            }
            Event::FootnoteReference(label) => writer.text(&format!("[{label}]")),
            Event::InlineMath(text) | Event::DisplayMath(text) => writer.text(text),
            _ => {}
        }
    }
    writer.flush();
    writer.rows
}

struct Writer<'a> {
    width: usize,
    context: RenderContext<'a>,
    rows: Vec<HyperlinkLine>,
    current: HyperlinkLine,
    styles: Vec<Style>,
    link: Option<String>,
    lists: Vec<Option<u64>>,
    list_widths: Vec<usize>,
    quote: usize,
    item_prefix: Option<String>,
    code: Option<(String, String)>,
    table: Option<table::Table>,
    code_index: usize,
}

impl Writer<'_> {
    fn style(&self) -> Style {
        self.styles.last().copied().unwrap_or_default()
    }
    fn push_style(&mut self, modifier: Modifier) {
        self.styles.push(self.style().add_modifier(modifier));
    }
    fn text(&mut self, text: &str) {
        if self.link.is_some() {
            self.current.push(text, self.style(), self.link.as_deref());
        } else {
            // Recognize bare web URLs without changing their visible spelling.
            for word in text.split_inclusive(char::is_whitespace) {
                let candidate = word.trim_end().trim_end_matches(['.', ',', ';', '!', '?']);
                let destination = crate::terminal::hyperlinks::web_destination(candidate);
                let style = if destination.is_some() {
                    self.style().add_modifier(Modifier::UNDERLINED)
                } else {
                    self.style()
                };
                self.current.push(candidate, style, destination.as_deref());
                self.current
                    .push(&word[candidate.len()..], self.style(), None);
            }
        }
    }
    fn indent(&self) -> usize {
        self.quote * 2 + self.list_widths.iter().sum::<usize>()
    }
    fn available_width(&self) -> usize {
        self.width.saturating_sub(self.indent()).max(1)
    }
    fn flush(&mut self) {
        if self.current.line.spans.is_empty() {
            return;
        }
        let current = std::mem::take(&mut self.current);
        let quote = "│ ".repeat(self.quote);
        let indent = " ".repeat(
            self.list_widths
                .iter()
                .take(self.list_widths.len().saturating_sub(1))
                .sum(),
        );
        let list_width = self.list_widths.last().copied().unwrap_or(0);
        let marker = self.item_prefix.take();
        for (index, mut row) in wrap(&current, self.available_width())
            .into_iter()
            .enumerate()
        {
            let list_prefix = if self.lists.is_empty() {
                String::new()
            } else if index == 0 {
                marker.clone().unwrap_or_else(|| " ".repeat(list_width))
            } else {
                " ".repeat(list_width)
            };
            row.prefix(Span::styled(
                format!("{quote}{indent}{list_prefix}"),
                Style::default().fg(self.context.muted()),
            ));
            self.rows.push(row);
        }
    }
}

#[cfg(test)]
#[path = "markdown_tests.rs"]
mod tests;
