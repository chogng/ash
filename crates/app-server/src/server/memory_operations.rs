use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;
use ash_memory_diagnostics::MemoryDiagnosticsError;
use ash_memory_diagnostics::MemoryEvidence;
use ash_memory_diagnostics::MemoryStart;
use serde_json::Value;
use std::time::Duration;

impl AppServer {
    pub(super) fn memory_diagnostics_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: MemoryStart = decode(params)?;
        result(
            &self
                .memory_diagnostics
                .start(connection.connection_id, params)
                .map_err(error)?,
        )
    }

    pub(super) fn memory_diagnostics_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: MemoryDiagnosticsSessionParams = decode(params)?;
        result(
            &self
                .memory_diagnostics
                .read(connection.connection_id, &params.session_id)
                .map_err(error)?,
        )
    }

    pub(super) fn memory_diagnostics_stop(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: MemoryDiagnosticsSessionParams = decode(params)?;
        result(
            &self
                .memory_diagnostics
                .stop(connection.connection_id, &params.session_id)
                .map_err(error)?,
        )
    }

    pub(super) fn memory_diagnostics_submit(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: MemoryEvidence = decode(params)?;
        self.memory_diagnostics
            .submit(connection.connection_id, params)
            .map_err(error)?;
        result(&())
    }

    pub(super) fn memory_diagnostics_export(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: MemoryDiagnosticsSessionParams = decode(params)?;
        let bytes = self
            .memory_diagnostics
            .export(connection.connection_id, &params.session_id)
            .map_err(error)?;
        let metadata = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?
            .create(
                connection.connection_id,
                "application/json".into(),
                bytes,
                Duration::from_secs(600),
            )
            .map_err(|_| RpcError::new(-32112, AppServerErrorName::MemoryDiagnosticsCapacity))?;
        result(&ResourceMetadataResult {
            resource_id: metadata.resource_id,
            mime_type: metadata.mime_type,
            size: metadata.size,
            sha256: metadata.sha256,
        })
    }
}

fn error(error: MemoryDiagnosticsError) -> RpcError {
    let name = match error {
        MemoryDiagnosticsError::Invalid => AppServerErrorName::InvalidParams,
        MemoryDiagnosticsError::Capacity => AppServerErrorName::MemoryDiagnosticsCapacity,
        MemoryDiagnosticsError::NotFound => AppServerErrorName::MemoryDiagnosticsNotFound,
        MemoryDiagnosticsError::Conflict => AppServerErrorName::MemoryDiagnosticsConflict,
        MemoryDiagnosticsError::Stopped => AppServerErrorName::MemoryDiagnosticsStopped,
        MemoryDiagnosticsError::Stale => AppServerErrorName::MemoryDiagnosticsStale,
        MemoryDiagnosticsError::Unavailable => AppServerErrorName::MemoryDiagnosticsUnavailable,
    };
    RpcError::new(
        if name == AppServerErrorName::InvalidParams {
            -32602
        } else {
            -32110
        },
        name,
    )
}
