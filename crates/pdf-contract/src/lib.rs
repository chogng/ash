//! aspdf domain values shared by native processing and the application protocol.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Page-relative coordinates in the displayed page, with the origin at the top left.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfCharacter {
    pub text: String,
    pub bounds: PdfRect,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfAnnotation {
    /// Index is valid only for this page and document revision.
    pub index: u32,
    pub kind: String,
    pub contents: String,
    pub author: String,
    pub bounds: PdfRect,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOutlineEntry {
    pub title: String,
    pub target: Option<PdfOutlineTarget>,
    pub children: Vec<PdfOutlineEntry>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOutlineTarget {
    #[schemars(range(min = 1))]
    pub page: u32,
    /// Vertical position in the displayed page, from its top to its bottom.
    #[schemars(range(min = 0, max = 1))]
    pub top: Option<f32>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PdfAnnotationEdit {
    Highlight { bounds: PdfRect, contents: String },
    Note { bounds: PdfRect, contents: String },
    Text { bounds: PdfRect, contents: String },
    Ink { points: Vec<PdfPoint> },
    Update { index: u32, contents: String },
    Delete { index: u32 },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPage {
    pub revision: u32,
    pub sha256: String,
    pub page_count: u32,
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub width_points: f32,
    pub height_points: f32,
    pub text: String,
    pub text_truncated: bool,
    pub characters: Vec<PdfCharacter>,
    pub annotations: Vec<PdfAnnotation>,
    pub annotations_truncated: bool,
    pub image_size: usize,
    pub image_sha256: String,
    pub file_size: usize,
}
