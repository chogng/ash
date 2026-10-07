use crate::inline;
use crate::model::{DiffDocument, DiffHunk, DiffLine, DiffRow, DiffRowKind, LineEnding};
use crate::myers::{self, Edit};
use crate::{
    CaseSensitivity, DiffError, DiffOptions, DiffSide, InlineDiffMode, LineEndingPolicy,
    WhitespacePolicy,
};

/// Cancellation probe observed throughout line and inline Myers searches.
///
/// Implementations should make `is_cancelled` cheap, thread-safe, and monotonic for the lifetime
/// of one computation. The engine never owns or resets the cancellation source.
pub trait DiffCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

/// Cancellation source used by synchronous callers that do not need interruption.
#[derive(Clone, Copy, Debug, Default)]
pub struct NeverCancel;

impl DiffCancellation for NeverCancel {
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Reusable immutable diff policy.
#[derive(Clone, Copy, Debug, Default)]
pub struct DiffEngine {
    options: DiffOptions,
}

impl DiffEngine {
    pub const fn new(options: DiffOptions) -> Self {
        Self { options }
    }

    pub const fn options(self) -> DiffOptions {
        self.options
    }

    pub fn compute(&self, original: &str, modified: &str) -> Result<DiffDocument, DiffError> {
        self.compute_cancellable(original, modified, &NeverCancel)
    }

    pub fn compute_cancellable(
        &self,
        original: &str,
        modified: &str,
        cancellation: &dyn DiffCancellation,
    ) -> Result<DiffDocument, DiffError> {
        validate_text(original, DiffSide::Original, self.options)?;
        validate_text(modified, DiffSide::Modified, self.options)?;
        compute_valid_text(original, modified, self.options, cancellation)
    }

    pub fn compute_bytes(
        &self,
        original: &[u8],
        modified: &[u8],
    ) -> Result<DiffDocument, DiffError> {
        self.compute_bytes_cancellable(original, modified, &NeverCancel)
    }

    pub fn compute_bytes_cancellable(
        &self,
        original: &[u8],
        modified: &[u8],
        cancellation: &dyn DiffCancellation,
    ) -> Result<DiffDocument, DiffError> {
        validate_bytes(original, DiffSide::Original, self.options)?;
        validate_bytes(modified, DiffSide::Modified, self.options)?;
        let original = std::str::from_utf8(original).map_err(|_| DiffError::InvalidUtf8 {
            side: DiffSide::Original,
        })?;
        let modified = std::str::from_utf8(modified).map_err(|_| DiffError::InvalidUtf8 {
            side: DiffSide::Modified,
        })?;
        compute_valid_text(original, modified, self.options, cancellation)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceLine {
    text: String,
    ending: LineEnding,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ComparisonKey {
    text: String,
    ending: Option<LineEnding>,
}

fn compute_valid_text(
    original: &str,
    modified: &str,
    options: DiffOptions,
    cancellation: &dyn DiffCancellation,
) -> Result<DiffDocument, DiffError> {
    if cancellation.is_cancelled() {
        return Err(DiffError::Cancelled);
    }
    let old_lines = split_lines(original, cancellation)?;
    let new_lines = split_lines(modified, cancellation)?;
    validate_line_count(old_lines.len(), DiffSide::Original, options)?;
    validate_line_count(new_lines.len(), DiffSide::Modified, options)?;

    let old_keys = comparison_keys(&old_lines, options, cancellation)?;
    let new_keys = comparison_keys(&new_lines, options, cancellation)?;
    let edits = myers::edits(&old_keys, &new_keys, options.limits(), cancellation)?;
    let rows = map_rows(edits, &old_lines, &new_lines, options, cancellation)?;
    let hunks = group_hunks(&rows, options.context_lines());
    Ok(DiffDocument::new(
        rows,
        hunks,
        old_lines.len(),
        new_lines.len(),
    ))
}

fn validate_text(text: &str, side: DiffSide, options: DiffOptions) -> Result<(), DiffError> {
    validate_bytes(text.as_bytes(), side, options)
}

fn validate_bytes(bytes: &[u8], side: DiffSide, options: DiffOptions) -> Result<(), DiffError> {
    let limit = options.limits().max_input_bytes_per_side();
    if bytes.len() > limit {
        return Err(DiffError::InputTooLarge {
            side,
            actual: bytes.len(),
            limit,
        });
    }
    if bytes.contains(&0) {
        return Err(DiffError::BinaryInput { side });
    }
    Ok(())
}

fn validate_line_count(
    actual: usize,
    side: DiffSide,
    options: DiffOptions,
) -> Result<(), DiffError> {
    let limit = options.limits().max_lines_per_side();
    if actual > limit {
        return Err(DiffError::TooManyLines {
            side,
            actual,
            limit,
        });
    }
    Ok(())
}

fn split_lines(
    text: &str,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<SourceLine>, DiffError> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if index & 4095 == 0 && cancellation.is_cancelled() {
            return Err(DiffError::Cancelled);
        }
        match bytes[index] {
            b'\n' => {
                let (text_end, ending) = if index > start && bytes[index - 1] == b'\r' {
                    (index - 1, LineEnding::CrLf)
                } else {
                    (index, LineEnding::Lf)
                };
                lines.push(SourceLine {
                    text: text[start..text_end].to_owned(),
                    ending,
                });
                start = index + 1;
            }
            b'\r' if bytes.get(index + 1) != Some(&b'\n') => {
                lines.push(SourceLine {
                    text: text[start..index].to_owned(),
                    ending: LineEnding::Cr,
                });
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if start < text.len() {
        lines.push(SourceLine {
            text: text[start..].to_owned(),
            ending: LineEnding::None,
        });
    }
    Ok(lines)
}

fn comparison_keys(
    lines: &[SourceLine],
    options: DiffOptions,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<ComparisonKey>, DiffError> {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index & 1023 == 0 && cancellation.is_cancelled() {
                return Err(DiffError::Cancelled);
            }
            let text = match options.whitespace() {
                WhitespacePolicy::Exact => line.text.clone(),
                WhitespacePolicy::TrimEdges => line.text.trim().to_owned(),
                WhitespacePolicy::CollapseRuns => {
                    line.text.split_whitespace().collect::<Vec<_>>().join(" ")
                }
            };
            let text = match options.case_sensitivity() {
                CaseSensitivity::Sensitive => text,
                CaseSensitivity::Insensitive => text.to_lowercase(),
            };
            Ok(ComparisonKey {
                text,
                ending: match options.line_endings() {
                    LineEndingPolicy::Sensitive => Some(line.ending),
                    LineEndingPolicy::Ignore => None,
                },
            })
        })
        .collect()
}

fn map_rows(
    edits: Vec<Edit>,
    old: &[SourceLine],
    new: &[SourceLine],
    options: DiffOptions,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<DiffRow>, DiffError> {
    let mut rows = Vec::with_capacity(edits.len());
    let mut index = 0;
    while index < edits.len() {
        let run_start = index;
        while index < edits.len() && !matches!(edits[index], Edit::Equal { .. }) {
            index += 1;
        }
        if run_start == index {
            let Edit::Equal {
                old: old_index,
                new: new_index,
            } = edits[index]
            else {
                unreachable!()
            };
            rows.push(DiffRow::new(
                DiffRowKind::Context,
                Some(diff_line(old_index, &old[old_index])),
                Some(diff_line(new_index, &new[new_index])),
                Vec::new(),
            ));
            index += 1;
            continue;
        }

        let removed = edits[run_start..index]
            .iter()
            .filter_map(|edit| match edit {
                Edit::Delete { old } => Some(*old),
                _ => None,
            })
            .collect::<Vec<_>>();
        let added = edits[run_start..index]
            .iter()
            .filter_map(|edit| match edit {
                Edit::Insert { new } => Some(*new),
                _ => None,
            })
            .collect::<Vec<_>>();
        let paired = removed.len().min(added.len());
        for pair in 0..paired {
            let old_line = &old[removed[pair]];
            let new_line = &new[added[pair]];
            let inline_changes = match options.inline() {
                InlineDiffMode::Disabled => Vec::new(),
                InlineDiffMode::Grapheme => inline::changes(
                    &old_line.text,
                    &new_line.text,
                    options.limits(),
                    cancellation,
                )?,
            };
            rows.push(DiffRow::new(
                DiffRowKind::Modified,
                Some(diff_line(removed[pair], old_line)),
                Some(diff_line(added[pair], new_line)),
                inline_changes,
            ));
        }
        for old_index in removed.into_iter().skip(paired) {
            rows.push(DiffRow::new(
                DiffRowKind::Removed,
                Some(diff_line(old_index, &old[old_index])),
                None,
                Vec::new(),
            ));
        }
        for new_index in added.into_iter().skip(paired) {
            rows.push(DiffRow::new(
                DiffRowKind::Added,
                None,
                Some(diff_line(new_index, &new[new_index])),
                Vec::new(),
            ));
        }
    }
    Ok(rows)
}

fn diff_line(index: usize, source: &SourceLine) -> DiffLine {
    DiffLine::new(index + 1, source.text.clone(), source.ending)
}

fn group_hunks(rows: &[DiffRow], context_lines: usize) -> Vec<DiffHunk> {
    let changes = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| (row.kind() != DiffRowKind::Context).then_some(index))
        .collect::<Vec<_>>();
    let Some(&first_change) = changes.first() else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    let mut start = first_change.saturating_sub(context_lines);
    let mut end = (first_change + context_lines + 1).min(rows.len());
    for &change in changes.iter().skip(1) {
        let next_start = change.saturating_sub(context_lines);
        let next_end = (change + context_lines + 1).min(rows.len());
        if next_start <= end {
            end = end.max(next_end);
        } else {
            ranges.push((start, end));
            start = next_start;
            end = next_end;
        }
    }
    ranges.push((start, end));
    ranges
        .into_iter()
        .map(|(start, end)| hunk(rows, start, end))
        .collect()
}

fn hunk(rows: &[DiffRow], start: usize, end: usize) -> DiffHunk {
    let old_count = rows[start..end]
        .iter()
        .filter(|row| row.old_line().is_some())
        .count();
    let new_count = rows[start..end]
        .iter()
        .filter(|row| row.new_line_number().is_some())
        .count();
    let old_start = side_start(rows, start, end, DiffRow::old_line);
    let new_start = side_start(rows, start, end, DiffRow::new_line_number);
    DiffHunk::new(start, end, old_start, old_count, new_start, new_count)
}

fn side_start(
    rows: &[DiffRow],
    start: usize,
    end: usize,
    line_number: fn(&DiffRow) -> Option<usize>,
) -> usize {
    rows[start..end]
        .iter()
        .find_map(line_number)
        .or_else(|| rows[..start].iter().rev().find_map(line_number))
        .unwrap_or(0)
}
