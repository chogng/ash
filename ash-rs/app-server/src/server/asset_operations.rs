use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::assets::AssetImageType;
use ash_app_server_protocol::protocol::assets::AssetImportParams;
use ash_app_server_protocol::protocol::assets::AssetImportStartParams;
use ash_app_server_protocol::protocol::assets::AssetImportStartResult;
use ash_app_server_protocol::protocol::assets::AssetImportWriteParams;
use ash_app_server_protocol::protocol::assets::AssetImportWriteResult;
use ash_app_server_protocol::protocol::assets::AssetReadParams;
use ash_app_server_protocol::protocol::assets::AssetReadResult;
use ash_app_server_protocol::protocol::assets::AssetVersionParams;
use ash_app_server_protocol::protocol::assets::AssetVersionResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use assets::AssetError;
use assets::AssetVersion;
use assets::ImageType;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

impl AppServer {
    fn asset_service(&self) -> Result<&assets::Assets, RpcError> {
        self.assets
            .as_deref()
            .ok_or_else(|| RpcError::new(-32130, AppServerErrorName::AssetsUnavailable))
    }

    pub(super) fn asset_import_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AssetImportStartParams = decode(params)?;
        self.asset_service()?
            .start(
                connection.connection_id,
                assets::ImportRequest {
                    asset_id: params.asset_id,
                    version_id: params.version_id,
                    name: params.name,
                    source: params.source,
                    size: params.size,
                },
            )
            .map_err(error)?;
        result(&AssetImportStartResult {
            max_chunk_bytes: assets::MAX_CHUNK_BYTES,
        })
    }

    pub(super) fn asset_import_write(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AssetImportWriteParams = decode(params)?;
        if params.data_base64.len() > assets::MAX_CHUNK_BYTES * 4 / 3 {
            return Err(error(AssetError::Invalid));
        }
        let bytes = STANDARD
            .decode(params.data_base64)
            .map_err(|_| error(AssetError::Invalid))?;
        let next_offset = self
            .asset_service()?
            .write(
                connection.connection_id,
                &params.version_id,
                params.offset,
                &bytes,
            )
            .map_err(error)?;
        result(&AssetImportWriteResult { next_offset })
    }

    pub(super) fn asset_import_finish(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AssetImportParams = decode(params)?;
        result(&version_result(
            self.asset_service()?
                .finish(connection.connection_id, &params.version_id)
                .map_err(error)?,
        ))
    }

    pub(super) fn asset_import_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: AssetImportParams = decode(params)?;
        self.asset_service()?
            .cancel(connection.connection_id, &params.version_id)
            .map_err(error)?;
        result(&())
    }

    pub(super) fn asset_version(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AssetVersionParams = decode(params)?;
        result(&version_result(
            self.asset_service()?
                .get(&params.asset_id, &params.version_id)
                .map_err(error)?,
        ))
    }

    pub(super) fn asset_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: AssetReadParams = decode(params)?;
        let service = self.asset_service()?;
        let version = service
            .get(&params.asset_id, &params.version_id)
            .map_err(error)?;
        let bytes = service
            .read(
                &params.asset_id,
                &params.version_id,
                params.offset,
                params.max_bytes,
            )
            .map_err(error)?;
        result(&AssetReadResult {
            offset: params.offset,
            decoded_length: bytes.len(),
            eof: params.offset + bytes.len() == version.size,
            data_base64: STANDARD.encode(bytes),
        })
    }
}

fn version_result(version: AssetVersion) -> AssetVersionResult {
    AssetVersionResult {
        asset_id: version.asset_id,
        version_id: version.version_id,
        name: version.name,
        source: version.source,
        sha256: version.sha256,
        media_type: match version.media_type {
            ImageType::Png => AssetImageType::Png,
            ImageType::Jpeg => AssetImageType::Jpeg,
            ImageType::Webp => AssetImageType::Webp,
        },
        size: version.size,
        width: version.width,
        height: version.height,
    }
}

fn error(error: AssetError) -> RpcError {
    let name = match error {
        AssetError::Invalid => AppServerErrorName::AssetInvalid,
        AssetError::InvalidImage => AppServerErrorName::AssetInvalidImage,
        AssetError::NotFound => AppServerErrorName::AssetNotFound,
        AssetError::Conflict => AppServerErrorName::AssetConflict,
        AssetError::Capacity => AppServerErrorName::AssetCapacity,
        AssetError::Storage(_) => AppServerErrorName::AssetOperationFailed,
    };
    RpcError::new(-32130, name)
}
