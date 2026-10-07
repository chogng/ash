use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::diff::DiffComputeParams;
use ash_app_server_protocol::protocol::diff::DiffComputeResult;
use ash_app_server_protocol::protocol::diff::DiffComputeRowDto;
use ash_app_server_protocol::protocol::diff::DiffHunkDto;
use ash_app_server_protocol::protocol::diff::DiffRangeDto;
use ash_app_server_protocol::protocol::diff::DiffRowKindDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_diff::DiffDocument;
use ash_diff::DiffError;
use ash_diff::DiffHunk;
use ash_diff::DiffLimits;
use ash_diff::DiffOptions;
use ash_diff::DiffRow;
use ash_diff::DiffRowKind;
use serde_json::Value;
use std::ops::Range;

const MAX_DIFF_INPUT_BYTES_PER_SIDE: usize = 512 * 1024;

impl AppServer {
    pub(super) fn diff_compute(&self, params: &Value) -> Result<Value, RpcError> {
        let params: DiffComputeParams = decode(params)?;
        let options = DiffOptions::default().with_limits(
            DiffLimits::default().with_max_input_bytes_per_side(MAX_DIFF_INPUT_BYTES_PER_SIDE),
        );
        let document = DiffDocument::with_options(&params.original, &params.modified, options)
            .map_err(diff_error)?;
        result(&project(document))
    }
}

fn project(document: DiffDocument) -> DiffComputeResult {
    DiffComputeResult {
        rows: document.rows().iter().map(project_row).collect(),
        hunks: document.hunks().iter().copied().map(project_hunk).collect(),
        original_line_count: document.old_line_count(),
        modified_line_count: document.new_line_count(),
    }
}

fn project_row(row: &DiffRow) -> DiffComputeRowDto {
    let original_ranges = row
        .inline_changes()
        .iter()
        .filter_map(|change| {
            let range = change.old_range();
            (range.start < range.end).then_some(range)
        })
        .collect();
    let modified_ranges = row
        .inline_changes()
        .iter()
        .filter_map(|change| {
            let range = change.new_range();
            (range.start < range.end).then_some(range)
        })
        .collect();
    DiffComputeRowDto {
        kind: project_row_kind(row.kind()),
        original_line_index: row.old_line().map(zero_based_line_index),
        modified_line_index: row.new_line_number().map(zero_based_line_index),
        original_changes: project_ranges(row.old_text(), original_ranges),
        modified_changes: project_ranges(row.new_text(), modified_ranges),
    }
}

fn project_row_kind(kind: DiffRowKind) -> DiffRowKindDto {
    match kind {
        DiffRowKind::Context => DiffRowKindDto::Context,
        DiffRowKind::Added => DiffRowKindDto::Added,
        DiffRowKind::Removed => DiffRowKindDto::Removed,
        DiffRowKind::Modified => DiffRowKindDto::Modified,
    }
}

fn project_ranges(text: Option<&str>, ranges: Vec<Range<usize>>) -> Vec<DiffRangeDto> {
    let Some(text) = text else {
        return Vec::new();
    };
    if ranges.is_empty() {
        return Vec::new();
    }
    let mut offsets = ranges
        .iter()
        .flat_map(|range| [range.start, range.end])
        .collect::<Vec<_>>();
    offsets.sort_unstable();
    offsets.dedup();
    let columns = utf16_columns(text, &offsets);
    ranges
        .into_iter()
        .map(|range| DiffRangeDto {
            start_column: lookup_utf16_column(&offsets, &columns, range.start),
            end_column: lookup_utf16_column(&offsets, &columns, range.end),
        })
        .collect()
}

fn project_hunk(hunk: DiffHunk) -> DiffHunkDto {
    DiffHunkDto {
        row_start: hunk.row_start(),
        row_end: hunk.row_end(),
        original_start_line_index: zero_based_line_index(hunk.old_start()),
        original_line_count: hunk.old_count(),
        modified_start_line_index: zero_based_line_index(hunk.new_start()),
        modified_line_count: hunk.new_count(),
    }
}

fn zero_based_line_index(line_number: usize) -> usize {
    line_number.saturating_sub(1)
}

fn utf16_columns(text: &str, offsets: &[usize]) -> Vec<usize> {
    let mut columns = Vec::with_capacity(offsets.len());
    let mut offset_index = 0;
    let mut column = 0;
    for (byte_offset, character) in text.char_indices() {
        while offsets.get(offset_index) == Some(&byte_offset) {
            columns.push(column);
            offset_index += 1;
        }
        column += character.len_utf16();
    }
    while offsets.get(offset_index) == Some(&text.len()) {
        columns.push(column);
        offset_index += 1;
    }
    assert_eq!(
        offset_index,
        offsets.len(),
        "diff range is not a UTF-8 boundary"
    );
    columns
}

fn lookup_utf16_column(offsets: &[usize], columns: &[usize], byte_offset: usize) -> usize {
    let index = offsets
        .binary_search(&byte_offset)
        .expect("diff range boundary was not indexed");
    columns[index]
}

fn diff_error(error: DiffError) -> RpcError {
    match error {
        DiffError::InputTooLarge { .. }
        | DiffError::TooManyLines { .. }
        | DiffError::InvalidUtf8 { .. }
        | DiffError::BinaryInput { .. } => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        DiffError::Cancelled
        | DiffError::EditDistanceLimit { .. }
        | DiffError::TraceLimit { .. } => {
            RpcError::new(-32070, AppServerErrorName::DiffOperationFailed)
        }
    }
}

#[cfg(test)]
#[path = "diff_operations_tests.rs"]
mod tests;
