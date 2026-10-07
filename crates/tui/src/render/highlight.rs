use super::RenderContext;
use super::StreamingCodeHighlighter;
use super::push_owned_lines;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::str::FromStr;
use std::sync::LazyLock;
use syntect::easy::ScopeRangeIterator;
use syntect::highlighting::ScopeSelectors;
use syntect::parsing::ParseState;
use syntect::parsing::ScopeStack;
use syntect::parsing::SyntaxReference;
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub(super) const MAX_CODE_BYTES: usize = 512 * 1024;
pub(super) const MAX_CODE_LINES: usize = 10_000;
pub(super) const MAX_LINE_BYTES: usize = 4 * 1024;

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);
static SELECTORS: LazyLock<SyntaxSelectors> = LazyLock::new(SyntaxSelectors::new);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SyntaxPalette {
    pub(crate) foreground: Color,
    pub(crate) function: Color,
    pub(crate) keyword: Color,
    pub(crate) muted: Color,
    pub(crate) string: Color,
    pub(crate) r#type: Color,
    pub(crate) variable: Color,
}

impl From<RenderContext<'_>> for SyntaxPalette {
    fn from(context: RenderContext<'_>) -> Self {
        Self {
            foreground: context.foreground(),
            function: context.function(),
            keyword: context.keyword(),
            muted: context.muted(),
            string: context.string(),
            r#type: context.r#type(),
            variable: context.variable(),
        }
    }
}

struct SyntaxSelectors {
    comment: ScopeSelectors,
    function: ScopeSelectors,
    keyword: ScopeSelectors,
    string: ScopeSelectors,
    r#type: ScopeSelectors,
    variable: ScopeSelectors,
}

impl SyntaxSelectors {
    fn new() -> Self {
        Self {
            comment: selector("comment"),
            function: selector("entity.name.function, support.function"),
            keyword: selector("keyword, storage.modifier, storage.type.function"),
            string: selector("string, constant.character"),
            r#type: selector("entity.name.type, entity.name.class, support.type, storage.type"),
            variable: selector("variable, constant.numeric, constant.language"),
        }
    }

    fn color(&self, scopes: &ScopeStack, palette: SyntaxPalette) -> Color {
        let scopes = scopes.as_slice();
        if self.comment.does_match(scopes).is_some() {
            palette.muted
        } else if self.string.does_match(scopes).is_some() {
            palette.string
        } else if self.function.does_match(scopes).is_some() {
            palette.function
        } else if self.keyword.does_match(scopes).is_some() {
            palette.keyword
        } else if self.r#type.does_match(scopes).is_some() {
            palette.r#type
        } else if self.variable.does_match(scopes).is_some() {
            palette.variable
        } else {
            palette.foreground
        }
    }
}

fn selector(value: &str) -> ScopeSelectors {
    ScopeSelectors::from_str(value).expect("built-in syntax selector should parse")
}

pub(crate) fn highlight_code(
    code: &str,
    language: &str,
    palette: SyntaxPalette,
) -> Vec<Line<'static>> {
    if code.is_empty() {
        return vec![Line::default()];
    }
    let complete = if code.ends_with('\n') {
        std::borrow::Cow::Borrowed(code)
    } else {
        std::borrow::Cow::Owned(format!("{code}\n"))
    };
    StreamingCodeHighlighter::start(&complete, language, palette, 0)
        .map(|(_, lines)| lines)
        .unwrap_or_else(|| plain_code(code, palette))
}

pub(super) fn syntax(language: &str) -> Option<&'static SyntaxReference> {
    let language = language.trim();
    if language.is_empty() {
        return None;
    }
    SYNTAXES
        .find_syntax_by_token(language)
        .or_else(|| SYNTAXES.find_syntax_by_extension(language))
}

pub(super) fn exceeds_limits(code: &str) -> bool {
    code.len() > MAX_CODE_BYTES
        || code.lines().count() > MAX_CODE_LINES
        || code.lines().any(|line| line.len() > MAX_LINE_BYTES)
}

pub(crate) fn code_within_limits(code: &str) -> bool {
    !exceeds_limits(code)
}

fn plain_code(code: &str, palette: SyntaxPalette) -> Vec<Line<'static>> {
    if code.is_empty() {
        return vec![Line::default()];
    }
    let lines = code
        .lines()
        .map(|line| {
            Line::from(Span::styled(
                line.to_owned(),
                Style::default().fg(palette.foreground),
            ))
        })
        .collect::<Vec<_>>();
    let mut output = Vec::with_capacity(lines.len());
    push_owned_lines(&lines, &mut output);
    output
}

pub(super) fn highlight_with_state(
    code: &str,
    palette: SyntaxPalette,
    parser: &mut ParseState,
    scopes: &mut ScopeStack,
) -> Option<Vec<Line<'static>>> {
    let mut output = Vec::new();
    for source_line in LinesWithEndings::from(code) {
        let without_newline = source_line.strip_suffix('\n').unwrap_or(source_line);
        let visible_len = without_newline
            .strip_suffix('\r')
            .unwrap_or(without_newline)
            .len();
        let operations = parser.parse_line(source_line, &SYNTAXES).ok()?;
        let mut spans = Vec::new();
        for (range, operation) in ScopeRangeIterator::new(&operations, source_line) {
            scopes.apply(operation).ok()?;
            let start = range.start.min(visible_len);
            let end = range.end.min(visible_len);
            if start == end {
                continue;
            }
            push_span(
                &mut spans,
                &source_line[start..end],
                Style::default().fg(SELECTORS.color(&scopes, palette)),
            );
        }
        output.push(Line::from(spans));
    }
    Some(output)
}

fn push_span(spans: &mut Vec<Span<'static>>, text: &str, style: Style) {
    if let Some(previous) = spans.last_mut()
        && previous.style == style
    {
        previous.content.to_mut().push_str(text);
        return;
    }
    spans.push(Span::styled(text.to_owned(), style));
}

#[cfg(test)]
#[path = "highlight_tests.rs"]
mod tests;
