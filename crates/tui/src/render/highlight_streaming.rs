//! Append-only syntax highlighting for complete source lines.

use super::SyntaxPalette;
use super::highlight::MAX_CODE_BYTES;
use super::highlight::MAX_CODE_LINES;
use super::highlight::MAX_LINE_BYTES;
use super::highlight::exceeds_limits;
use super::highlight::highlight_with_state;
use super::highlight::syntax;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use syntect::parsing::ParseState;
use syntect::parsing::ScopeStack;

/// Retains Syntect parser state for an append-only sequence of complete source lines.
///
/// Callers keep the canonical source and rendered prefix. `append` returns `None` when the input
/// is incomplete, the theme changes, parsing fails, or a resource limit is crossed; the caller
/// must then render the complete canonical source again.
#[derive(Debug)]
pub(crate) struct StreamingCodeHighlighter {
    bytes: usize,
    lines: usize,
    parser: Option<ParserState>,
    theme_revision: u64,
}

#[derive(Debug)]
struct ParserState {
    parser: ParseState,
    scopes: ScopeStack,
}

impl StreamingCodeHighlighter {
    #[cfg(test)]
    pub(crate) fn new(
        code: &str,
        language: &str,
        palette: SyntaxPalette,
        theme_revision: u64,
    ) -> Option<Self> {
        Self::start(code, language, palette, theme_revision).map(|(highlighter, _)| highlighter)
    }

    pub(crate) fn start(
        code: &str,
        language: &str,
        palette: SyntaxPalette,
        theme_revision: u64,
    ) -> Option<(Self, Vec<Line<'static>>)> {
        if !code.is_empty() && !code.ends_with('\n') {
            return None;
        }
        let (parser, rendered) =
            if let Some(syntax) = syntax(language).filter(|_| !exceeds_limits(code)) {
                let mut parser = ParseState::new(syntax);
                let mut scopes = ScopeStack::new();
                let rendered = highlight_with_state(code, palette, &mut parser, &mut scopes)?;
                (Some(ParserState { parser, scopes }), rendered)
            } else {
                (None, plain_complete_lines(code, palette))
            };
        Some((
            Self {
                bytes: code.len(),
                lines: code.lines().count(),
                parser,
                theme_revision,
            },
            rendered,
        ))
    }

    pub(crate) fn append(
        mut self,
        appended: &str,
        palette: SyntaxPalette,
        theme_revision: u64,
    ) -> Option<(Self, Vec<Line<'static>>)> {
        if appended.is_empty() || !appended.ends_with('\n') || self.theme_revision != theme_revision
        {
            return None;
        }
        let bytes = self.bytes.checked_add(appended.len())?;
        let lines = self.lines.checked_add(appended.lines().count())?;
        if bytes > MAX_CODE_BYTES
            || lines > MAX_CODE_LINES
            || appended.lines().any(|line| line.len() > MAX_LINE_BYTES)
        {
            return None;
        }
        let rendered = if let Some(state) = self.parser.as_mut() {
            highlight_with_state(appended, palette, &mut state.parser, &mut state.scopes)?
        } else {
            plain_complete_lines(appended, palette)
        };
        self.bytes = bytes;
        self.lines = lines;
        Some((self, rendered))
    }
}

fn plain_complete_lines(code: &str, palette: SyntaxPalette) -> Vec<Line<'static>> {
    code.lines()
        .map(|line| {
            Line::from(Span::styled(
                line.to_owned(),
                Style::default().fg(palette.foreground),
            ))
        })
        .collect()
}

#[cfg(test)]
#[path = "highlight_streaming_tests.rs"]
mod tests;
