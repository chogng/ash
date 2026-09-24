use ansi_to_tui::IntoText;
use ratatui::text::Text;
use std::borrow::Cow;

/// Converts ANSI-styled text into owned Ratatui presentation text.
///
/// ANSI SGR sequences become Ratatui styles, other terminal control sequences
/// are removed by the parser, and tabs become four spaces so callers can safely
/// prepend transcript gutters. Conversion is best-effort and never fails; if
/// parsing fails, the returned plain text has raw escape bytes removed.
pub fn ansi_text(input: &str) -> Text<'static> {
    let input = expand_tabs(input);
    input
        .as_ref()
        .into_text()
        .unwrap_or_else(|_| Text::raw(input.replace('\x1b', "")))
}

fn expand_tabs(input: &str) -> Cow<'_, str> {
    if input.contains('\t') {
        Cow::Owned(input.replace('\t', "    "))
    } else {
        Cow::Borrowed(input)
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
