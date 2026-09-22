use ash_app_server_protocol::protocol::attachments::AttachmentImportRemoteParams;
use ash_app_server_protocol::protocol::attachments::AttachmentMaterializeResult;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadCancelParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadFinishParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadStartParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadStartResult;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadWriteParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadWriteResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use crate::attachment_upload_store::AttachmentUploadContent;
use crate::attachment_upload_store::AttachmentUploadError;
use crate::attachment_upload_store::MAX_ATTACHMENT_UPLOAD_CHUNK_BYTES;
use ash_protocol::AttachmentRef;

impl AppServer {
    pub(super) fn attachment_upload_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AttachmentUploadStartParams = decode(params)?;
        let (content, encoded_bytes) = match params {
            AttachmentUploadStartParams::Image {
                media_type,
                detail: _,
                encoded_bytes,
            } => (AttachmentUploadContent::Image { media_type }, encoded_bytes),
            AttachmentUploadStartParams::Audio {
                media_type,
                encoded_bytes,
            } => (AttachmentUploadContent::Audio { media_type }, encoded_bytes),
        };
        let expected_bytes =
            usize::try_from(encoded_bytes).map_err(|_| invalid_attachment_params())?;
        let upload_id = self
            .attachment_uploads
            .lock()
            .map_err(|_| internal_attachment_error())?
            .start(connection.connection_id, content, expected_bytes)
            .map_err(upload_error)?;
        result(&AttachmentUploadStartResult {
            upload_id,
            max_chunk_bytes: MAX_ATTACHMENT_UPLOAD_CHUNK_BYTES,
        })
    }

    pub(super) fn attachment_upload_write(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AttachmentUploadWriteParams = decode(params)?;
        if params.data_base64.len() > MAX_ATTACHMENT_UPLOAD_CHUNK_BYTES.div_ceil(3) * 4 + 4 {
            return Err(invalid_attachment_params());
        }
        let chunk = STANDARD
            .decode(params.data_base64)
            .map_err(|_| invalid_attachment_params())?;
        let offset = usize::try_from(params.offset).map_err(|_| invalid_attachment_params())?;
        let next_offset = self
            .attachment_uploads
            .lock()
            .map_err(|_| internal_attachment_error())?
            .write(connection.connection_id, &params.upload_id, offset, &chunk)
            .map_err(upload_error)?;
        result(&AttachmentUploadWriteResult {
            next_offset: next_offset as u64,
        })
    }

    pub(super) fn attachment_upload_finish(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AttachmentUploadFinishParams = decode(params)?;
        let upload = self
            .attachment_uploads
            .lock()
            .map_err(|_| internal_attachment_error())?
            .finish(connection.connection_id, &params.upload_id)
            .map_err(upload_error)?;
        let attachments = self.threads.attachments();
        let attachment = match upload.content {
            AttachmentUploadContent::Image { media_type } => AttachmentRef::Image(
                attachments
                    .import_bytes(upload.bytes, media_type)
                    .map_err(|_| invalid_attachment_params())?,
            ),
            AttachmentUploadContent::Audio { media_type } => AttachmentRef::Audio(
                attachments
                    .import_audio_bytes(upload.bytes, media_type)
                    .map_err(|_| invalid_attachment_params())?,
            ),
        };
        result(&AttachmentMaterializeResult { attachment })
    }

    pub(super) fn attachment_upload_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AttachmentUploadCancelParams = decode(params)?;
        self.attachment_uploads
            .lock()
            .map_err(|_| internal_attachment_error())?
            .cancel(connection.connection_id, &params.upload_id)
            .map_err(upload_error)?;
        result(&())
    }

    pub(super) fn attachment_import_remote(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AttachmentImportRemoteParams = decode(params)?;
        let attachment = self
            .threads
            .attachments()
            .import_remote_url(&params.url)
            .map_err(|_| invalid_attachment_params())?;
        result(&AttachmentMaterializeResult {
            attachment: AttachmentRef::Image(attachment),
        })
    }
}

fn upload_error(_: AttachmentUploadError) -> RpcError {
    invalid_attachment_params()
}

fn invalid_attachment_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn internal_attachment_error() -> RpcError {
    RpcError::new(-32000, AppServerErrorName::InternalError)
}
