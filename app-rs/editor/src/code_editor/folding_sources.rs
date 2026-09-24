//! Text-derived folding candidates owned by the CodeEditor document layer.

use std::ops::Range;

use super::CodeEditorFoldingRange;
use super::CodeEditorLanguage;

/// Derives folding candidates that do not require parser support.
///
/// Indentation candidates apply to every language. Region candidates deliberately recognize only
/// language comment forms so ordinary source text cannot accidentally create a folding control.
pub(super) fn derived_folding_ranges(
    text: &str,
    line_ranges: &[Range<usize>],
    language: CodeEditorLanguage,
) -> Vec<CodeEditorFoldingRange> {
    let mut ranges = indentation_folding_ranges(text, line_ranges);
    ranges.extend(region_folding_ranges(text, line_ranges, language));
    ranges.sort_by_key(|range| (range.start_row(), std::cmp::Reverse(range.end_row())));
    ranges
}

fn indentation_folding_ranges(
    text: &str,
    line_ranges: &[Range<usize>],
) -> Vec<CodeEditorFoldingRange> {
    let lines = line_ranges
        .iter()
        .map(|range| &text[range.clone()])
        .collect::<Vec<_>>();
    let mut ranges = Vec::new();

    for (start_row, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let start_indent = indentation_columns(line);
        let Some(first_child_row) =
            ((start_row + 1)..lines.len()).find(|row| !lines[*row].trim().is_empty())
        else {
            continue;
        };
        if indentation_columns(lines[first_child_row]) <= start_indent {
            continue;
        }

        let mut end_row = first_child_row;
        for (row, line) in lines.iter().enumerate().skip(first_child_row + 1) {
            if !line.trim().is_empty() && indentation_columns(line) <= start_indent {
                break;
            }
            end_row = row;
        }
        if let Some(range) = CodeEditorFoldingRange::new(start_row, end_row) {
            ranges.push(range);
        }
    }
    ranges
}

fn indentation_columns(line: &str) -> usize {
    line.chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .fold(0, |columns, character| match character {
            ' ' => columns + 1,
            '\t' => (columns / 4 + 1) * 4,
            _ => unreachable!("only leading indentation reaches this fold"),
        })
}

fn region_folding_ranges(
    text: &str,
    line_ranges: &[Range<usize>],
    language: CodeEditorLanguage,
) -> Vec<CodeEditorFoldingRange> {
    let mut starts = Vec::new();
    let mut ranges = Vec::new();
    for (row, line_range) in line_ranges.iter().enumerate() {
        match region_marker(language, &text[line_range.clone()]) {
            Some(RegionMarker::Start) => starts.push(row),
            Some(RegionMarker::End) => {
                if let Some(start_row) = starts.pop()
                    && let Some(range) = CodeEditorFoldingRange::new(start_row, row)
                {
                    ranges.push(range);
                }
            }
            None => {}
        }
    }
    ranges
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RegionMarker {
    Start,
    End,
}

fn region_marker(language: CodeEditorLanguage, line: &str) -> Option<RegionMarker> {
    let line = line.trim_start();
    let marker = match language {
        CodeEditorLanguage::Rust | CodeEditorLanguage::Jsonc => line.strip_prefix("//")?,
        CodeEditorLanguage::Shell => line.strip_prefix('#')?,
        CodeEditorLanguage::PlainText | CodeEditorLanguage::Json => return None,
    }
    .split_whitespace()
    .next()?;
    match marker {
        "#region" | "region" => Some(RegionMarker::Start),
        "#endregion" | "endregion" => Some(RegionMarker::End),
        _ => None,
    }
}

#[cfg(test)]
#[path = "folding_sources_tests.rs"]
mod tests;
