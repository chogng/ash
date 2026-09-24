use std::ops::Range;

use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use zui::ui::{Color, TextSpan, TextStyle};

/// One syntax color override over a UTF-8 byte range in a fenced code block.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownSyntaxSpan {
    pub range: Range<usize>,
    pub color: Color,
}

/// Supplies language-aware code colors to Markdown layout.
///
/// Implementations must return sorted, non-overlapping UTF-8 byte ranges within `source`. Invalid
/// ranges are ignored, so an untrusted or partial highlighter cannot make layout panic.
pub trait MarkdownSyntaxHighlighter {
    fn highlight(&self, language: &str, source: &str) -> Vec<MarkdownSyntaxSpan>;
}

/// Built-in `syntect` highlighter using bundled syntaxes and a neutral dark-on-light theme.
pub struct SyntectMarkdownHighlighter {
    syntaxes: SyntaxSet,
    theme: Theme,
}

impl SyntectMarkdownHighlighter {
    pub fn new() -> Self {
        let themes = ThemeSet::load_defaults();
        Self {
            syntaxes: SyntaxSet::load_defaults_newlines(),
            theme: themes.themes["InspiredGitHub"].clone(),
        }
    }
}

impl Default for SyntectMarkdownHighlighter {
    fn default() -> Self {
        Self::new()
    }
}

impl MarkdownSyntaxHighlighter for SyntectMarkdownHighlighter {
    fn highlight(&self, language: &str, source: &str) -> Vec<MarkdownSyntaxSpan> {
        let syntax = self
            .syntaxes
            .find_syntax_by_token(language)
            .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
        let mut highlighter = HighlightLines::new(syntax, &self.theme);
        let mut spans = Vec::new();
        let mut offset = 0;
        for line in LinesWithEndings::from(source) {
            let Ok(parts) = highlighter.highlight_line(line, &self.syntaxes) else {
                return Vec::new();
            };
            for (style, text) in parts {
                let end = offset + text.len();
                spans.push(MarkdownSyntaxSpan {
                    range: offset..end,
                    color: Color::rgba(
                        style.foreground.r,
                        style.foreground.g,
                        style.foreground.b,
                        style.foreground.a,
                    ),
                });
                offset = end;
            }
        }
        spans
    }
}

pub(crate) fn highlighted_code_spans(
    highlighter: &dyn MarkdownSyntaxHighlighter,
    language: Option<&str>,
    source: &str,
    style: &TextStyle,
) -> Vec<TextSpan> {
    let Some(language) = language else {
        return vec![TextSpan::new(source, style.clone())];
    };
    let mut result = Vec::new();
    let mut offset = 0;
    for highlighted in highlighter.highlight(language, source) {
        if highlighted.range.start < offset
            || highlighted.range.end > source.len()
            || highlighted.range.start >= highlighted.range.end
            || !source.is_char_boundary(highlighted.range.start)
            || !source.is_char_boundary(highlighted.range.end)
        {
            continue;
        }
        if highlighted.range.start > offset {
            result.push(TextSpan::new(
                &source[offset..highlighted.range.start],
                style.clone(),
            ));
        }
        result.push(TextSpan::new(
            &source[highlighted.range.clone()],
            style.clone().with_color(highlighted.color),
        ));
        offset = highlighted.range.end;
    }
    if offset < source.len() {
        result.push(TextSpan::new(&source[offset..], style.clone()));
    }
    if result.is_empty() {
        result.push(TextSpan::new(source, style.clone()));
    }
    result
}
