use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Final screen rows retain source columns for annotations such as hyperlinks.
/// Styles never decide word or grapheme boundaries; a grapheme crossing spans uses
/// the style at its first byte because a terminal glyph cannot carry partial styles.
pub(crate) struct WrappedLine {
    pub(crate) line: Line<'static>,
    pub(crate) source_columns: Vec<usize>,
}

pub(crate) fn wrap_line(line: &Line<'_>, width: usize) -> Vec<WrappedLine> {
    if width == 0 {
        return Vec::new();
    }
    let text = line.to_string();
    let mut styles = Vec::new();
    let mut end = 0;
    for span in &line.spans {
        end += span.content.len();
        styles.push((end, line.style.patch(span.style)));
    }
    let empty_row = || WrappedLine {
        line: Line {
            alignment: line.alignment,
            ..Line::default()
        },
        source_columns: Vec::new(),
    };
    let mut rows = Vec::new();
    let mut row = empty_row();
    let mut used = 0;
    let mut source_column = 0;
    let mut style_index = 0;
    // Keep command names, paths and URLs intact until a token itself exceeds the
    // row width. Color boundaries and punctuation do not create break opportunities.
    let mut words = Vec::new();
    let mut start = 0;
    let mut whitespace = None;
    for (offset, glyph) in text.grapheme_indices(true) {
        let next = glyph.chars().all(char::is_whitespace);
        if whitespace.is_some_and(|previous| previous != next) {
            words.push((start, &text[start..offset]));
            start = offset;
        }
        whitespace = Some(next);
    }
    if start < text.len() {
        words.push((start, &text[start..]));
    }
    for (word_start, word) in words {
        let word_width = display_width(word);
        if used > 0 && word_width <= width && used + word_width > width {
            rows.push(row);
            row = empty_row();
            used = 0;
            if word.chars().all(char::is_whitespace) {
                source_column += word_width;
                continue;
            }
        }
        for (offset, glyph) in word.grapheme_indices(true) {
            let glyph_width = display_width(glyph);
            let column = source_column;
            source_column += glyph_width;
            if used > 0 && used + glyph_width > width {
                rows.push(row);
                row = empty_row();
                used = 0;
                if glyph.chars().all(char::is_whitespace) {
                    continue;
                }
            }
            if glyph_width > width || glyph.chars().any(char::is_control) {
                continue;
            }
            while styles[style_index].0 <= word_start + offset {
                style_index += 1;
            }
            let style = styles[style_index].1;
            if let Some(last) = row.line.spans.last_mut().filter(|s| s.style == style) {
                last.content.to_mut().push_str(glyph);
            } else {
                row.line.push_span(Span::styled(glyph.to_owned(), style));
            }
            row.source_columns.extend(column..column + glyph_width);
            used += glyph_width;
        }
    }
    if !row.line.spans.is_empty() || rows.is_empty() {
        rows.push(row);
    }
    rows
}

pub(crate) fn wrap_lines(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    lines
        .iter()
        .flat_map(|line| wrap_line(line, width))
        .map(|row| row.line)
        .collect()
}

/// Prefixes may shrink on narrow surfaces, but must leave room for content.
pub(crate) fn prefix_width(width: usize, desired: usize) -> usize {
    desired.min(width.saturating_sub(1))
}

pub(crate) fn display_width(text: &str) -> usize {
    text.width()
}

pub(crate) fn truncate_to_width(text: &str, width: usize) -> String {
    let mut rendered = String::new();
    let mut used = 0;
    for grapheme in text.graphemes(true) {
        let grapheme_width = display_width(grapheme);
        if used + grapheme_width > width {
            break;
        }
        rendered.push_str(grapheme);
        used += grapheme_width;
    }
    rendered
}

pub(crate) fn line_to_borrowed<'a>(line: &'a Line<'_>) -> Line<'a> {
    Line {
        style: line.style,
        alignment: line.alignment,
        spans: line
            .spans
            .iter()
            .map(|span| Span::styled(span.content.as_ref() as &str, span.style))
            .collect(),
    }
}

pub(crate) fn line_to_static(line: &Line<'_>) -> Line<'static> {
    Line {
        style: line.style,
        alignment: line.alignment,
        spans: line
            .spans
            .iter()
            .map(|span| Span::styled(span.content.to_string(), span.style))
            .collect(),
    }
}

pub(crate) fn push_owned_lines(source: &[Line<'_>], output: &mut Vec<Line<'static>>) {
    output.extend(source.iter().map(line_to_static));
}

pub(crate) fn prefix_lines<'a>(
    lines: Vec<Line<'a>>,
    initial: Span<'a>,
    subsequent: Span<'a>,
) -> Vec<Line<'a>> {
    lines
        .into_iter()
        .enumerate()
        .map(|(index, mut line)| {
            line.spans.insert(
                0,
                if index == 0 {
                    initial.clone()
                } else {
                    subsequent.clone()
                },
            );
            line
        })
        .collect()
}

pub(crate) fn styled_text_lines<'a>(text: &'a str, style: Style) -> Vec<Line<'a>> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| Line::from(Span::styled(line, style)))
        .collect()
}

pub(crate) fn wrapped_height(lines: &[Line<'_>], width: u16) -> usize {
    Paragraph::new(lines.to_vec())
        .wrap(Wrap { trim: false })
        .line_count(width)
}

pub(crate) fn truncate_with_ellipsis(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if display_width(text) <= width {
        return text.to_owned();
    }
    if width == 1 {
        return "…".into();
    }

    let mut rendered = truncate_to_width(text, width - 1);
    rendered.push('…');
    rendered
}

#[cfg(test)]
#[path = "text_tests.rs"]
mod tests;
