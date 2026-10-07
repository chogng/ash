use crate::JsonSchema;
use crate::TS;
use ash_protocol::AttachmentRef;
use ash_protocol::AudioMediaType;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(untagged, deny_unknown_fields, rename_all_fields = "camelCase")]
pub enum AttachmentUploadStartParams {
    Image {
        media_type: ImageMediaType,
        #[ts(type = "number")]
        encoded_bytes: u64,
        detail: ImageDetail,
    },
    Audio {
        media_type: AudioMediaType,
        #[ts(type = "number")]
        encoded_bytes: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadStartResult {
    pub upload_id: String,
    pub max_chunk_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadWriteParams {
    #[schemars(length(min = 1))]
    pub upload_id: String,
    #[ts(type = "number")]
    pub offset: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadWriteResult {
    #[ts(type = "number")]
    pub next_offset: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadFinishParams {
    #[schemars(length(min = 1))]
    pub upload_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadCancelParams {
    #[schemars(length(min = 1))]
    pub upload_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImportRemoteParams {
    #[schemars(length(min = 1, max = 8192))]
    pub url: String,
    pub detail: ImageDetail,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMaterializeResult {
    pub attachment: AttachmentRef,
}
