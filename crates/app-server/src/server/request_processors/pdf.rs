use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::pdf::*;
use ash_pdf::PdfError;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

impl super::AppServer {
    pub(super) fn pdf_open(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: PdfOpenParams = decode(value)?;
        self.pdf
            .open(connection.connection_id, &params.document_id, params.size)
            .map_err(error)?;
        result(&())
    }

    pub(super) fn pdf_append(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: PdfAppendParams = decode(value)?;
        if params.data_base64.len() > ash_pdf::MAX_CHUNK_BYTES * 4 / 3 {
            return Err(error(PdfError::Invalid));
        }
        let bytes = STANDARD
            .decode(params.data_base64)
            .map_err(|_| error(PdfError::Invalid))?;
        let next_offset = self
            .pdf
            .append(
                connection.connection_id,
                &params.document_id,
                params.offset,
                &bytes,
            )
            .map_err(error)?;
        result(&PdfAppendResult { next_offset })
    }

    pub(super) fn pdf_page(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: PdfPageParams = decode(value)?;
        let page = self
            .pdf
            .page(
                connection.connection_id,
                &params.document_id,
                params.revision,
                params.page,
                params.dimension,
                params.edit,
            )
            .map_err(error)?;
        result(&page)
    }

    pub(super) fn pdf_read(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: PdfReadParams = decode(value)?;
        let (bytes, eof) = self
            .pdf
            .read(
                connection.connection_id,
                &params.document_id,
                params.revision,
                params.image,
                params.image_sha256.as_deref(),
                params.offset,
                params.max_bytes,
            )
            .map_err(error)?;
        result(&PdfReadResult {
            data_base64: STANDARD.encode(bytes),
            eof,
        })
    }

    pub(super) fn pdf_close(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: PdfCloseParams = decode(value)?;
        self.pdf
            .close(connection.connection_id, &params.document_id);
        result(&())
    }
}

fn error(error: PdfError) -> RpcError {
    let name = match error {
        PdfError::Invalid => AppServerErrorName::PdfInvalid,
        PdfError::NotFound => AppServerErrorName::PdfNotFound,
        PdfError::Conflict => AppServerErrorName::PdfConflict,
        PdfError::Capacity => AppServerErrorName::PdfCapacity,
        PdfError::Cancelled => AppServerErrorName::PdfCancelled,
        PdfError::Failed(_) => AppServerErrorName::PdfOperationFailed,
    };
    RpcError::new(-32170, name)
}
