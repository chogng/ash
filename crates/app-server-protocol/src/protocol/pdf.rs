use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

pub use ash_pdf_contract::PdfAnnotationEdit;
pub use ash_pdf_contract::PdfPage;

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOpenParams {
    #[schemars(length(min = 1, max = 128))]
    pub document_id: String,
    #[schemars(range(min = 1, max = 67108864))]
    pub size: usize,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfAppendParams {
    pub document_id: String,
    pub offset: usize,
    #[schemars(length(min = 1, max = 262144))]
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfAppendResult {
    pub next_offset: usize,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPageParams {
    pub document_id: String,
    pub revision: u32,
    #[schemars(range(min = 1))]
    pub page: u32,
    #[schemars(range(min = 256, max = 2048))]
    pub dimension: u32,
    pub edit: Option<PdfAnnotationEdit>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfReadParams {
    pub document_id: String,
    pub revision: u32,
    pub image: bool,
    pub image_sha256: Option<String>,
    pub offset: usize,
    #[schemars(range(min = 1, max = 196608))]
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfReadResult {
    pub data_base64: String,
    pub eof: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfCloseParams {
    pub document_id: String,
}
