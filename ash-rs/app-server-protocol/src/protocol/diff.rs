use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Inputs for one presentation-independent comparison of two text snapshots.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffComputeParams {
    #[schemars(length(max = 524_288))]
    pub original: String,
    #[schemars(length(max = 524_288))]
    pub modified: String,
}

/// The semantic kind of one aligned original/modified row.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DiffRowKindDto {
    Context,
    Added,
    Removed,
    Modified,
}

/// One changed inline region expressed in the editor's zero-based UTF-16 columns.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffRangeDto {
    pub start_column: usize,
    pub end_column: usize,
}

/// One aligned diff row in the frontend's zero-based line coordinate system.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffComputeRowDto {
    pub kind: DiffRowKindDto,
    pub original_line_index: Option<usize>,
    pub modified_line_index: Option<usize>,
    pub original_changes: Vec<DiffRangeDto>,
    pub modified_changes: Vec<DiffRangeDto>,
}

/// One bounded hunk range in the returned row projection.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkDto {
    pub row_start: usize,
    pub row_end: usize,
    pub original_start_line_index: usize,
    pub original_line_count: usize,
    pub modified_start_line_index: usize,
    pub modified_line_count: usize,
}

/// Canonical Rust diff data projected for a frontend line model.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffComputeResult {
    pub rows: Vec<DiffComputeRowDto>,
    pub hunks: Vec<DiffHunkDto>,
    pub original_line_count: usize,
    pub modified_line_count: usize,
}
