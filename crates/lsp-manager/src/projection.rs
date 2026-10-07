//! Conversion from negotiated LSP positions into product-neutral editor byte ranges.

use ash_lsp::lsp_types::{
    Diagnostic, DiagnosticSeverity, NumberOrString, Position, PositionEncodingKind,
};

use crate::{LanguageDiagnostic, LanguageDiagnosticSeverity, LanguageTextRange};

pub(super) fn project_diagnostic(
    text: &str,
    diagnostic: Diagnostic,
    encoding: &PositionEncodingKind,
) -> Option<LanguageDiagnostic> {
    let range =
        byte_range_for_lsp_range(text, diagnostic.range.start, diagnostic.range.end, encoding)?;
    Some(LanguageDiagnostic {
        range: LanguageTextRange::new(range),
        severity: severity(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnostic.code.map(code_string),
    })
}

pub(super) fn byte_range_for_lsp_range(
    text: &str,
    start: Position,
    end: Position,
    encoding: &PositionEncodingKind,
) -> Option<std::ops::Range<usize>> {
    let start = byte_offset_for_position(text, start, encoding)?;
    let end = byte_offset_for_position(text, end, encoding)?;
    (start <= end).then_some(start..end)
}

pub(super) fn byte_offset_for_position(
    text: &str,
    position: Position,
    encoding: &PositionEncodingKind,
) -> Option<usize> {
    let line = usize::try_from(position.line).ok()?;
    let character = usize::try_from(position.character).ok()?;
    let (start, content) = line_at(text, line)?;
    if *encoding == PositionEncodingKind::UTF8 {
        return (character <= content.len() && content.is_char_boundary(character))
            .then_some(start + character);
    }
    if *encoding != PositionEncodingKind::UTF16 {
        return None;
    }
    let mut units = 0;
    for (offset, scalar) in content.char_indices() {
        if units == character {
            return Some(start + offset);
        }
        units += scalar.len_utf16();
        if units > character {
            return None;
        }
    }
    (units == character).then_some(start + content.len())
}

fn line_at(text: &str, requested: usize) -> Option<(usize, &str)> {
    let mut start = 0;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let without_newline = line.strip_suffix('\n').unwrap_or(line);
        let content = without_newline
            .strip_suffix('\r')
            .unwrap_or(without_newline);
        if index == requested {
            return Some((start, content));
        }
        start += line.len();
    }
    if text.ends_with('\n') && requested == text.lines().count() {
        return Some((text.len(), ""));
    }
    None
}

pub(super) fn severity(value: Option<DiagnosticSeverity>) -> LanguageDiagnosticSeverity {
    match value {
        Some(DiagnosticSeverity::ERROR) => LanguageDiagnosticSeverity::Error,
        Some(DiagnosticSeverity::WARNING) => LanguageDiagnosticSeverity::Warning,
        Some(DiagnosticSeverity::HINT) => LanguageDiagnosticSeverity::Hint,
        Some(DiagnosticSeverity::INFORMATION) | None | Some(_) => {
            LanguageDiagnosticSeverity::Information
        }
    }
}

pub(super) fn code_string(code: NumberOrString) -> String {
    match code {
        NumberOrString::Number(number) => number.to_string(),
        NumberOrString::String(code) => code,
    }
}
