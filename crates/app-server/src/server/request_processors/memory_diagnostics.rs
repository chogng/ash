use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use crate::resource_store::ResourceStore;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;
use ash_memory_diagnostics::MemoryDiagnostics;
use ash_memory_diagnostics::MemoryDiagnosticsError;
use ash_memory_diagnostics::MemoryEvidence;
use ash_memory_diagnostics::MemoryStart;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

/// Owns the memory-diagnostics RPC adapter and its connection-scoped recordings.
/// The shared resource store remains authoritative for exported report bytes.
pub(super) struct MemoryDiagnosticsRequestProcessor {
    diagnostics: MemoryDiagnostics,
    resources: Arc<Mutex<ResourceStore>>,
}

impl MemoryDiagnosticsRequestProcessor {
    pub(super) fn new(resources: Arc<Mutex<ResourceStore>>) -> Self {
        Self {
            diagnostics: MemoryDiagnostics::default(),
            resources,
        }
    }

    pub(super) fn connection_closed(&self, connection_id: u64) {
        self.diagnostics.close_owner(connection_id);
    }

    pub(super) fn start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        // Hold the connection lock through the operation so close cannot retire
        // this owner before a recording or exported resource is published.
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
                .diagnostics
                .start(connection.connection_id, params)
                .map_err(error)?,
        )
    }

    pub(super) fn read(
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
                .diagnostics
                .read(connection.connection_id, &params.session_id)
                .map_err(error)?,
        )
    }

    pub(super) fn stop(
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
                .diagnostics
                .stop(connection.connection_id, &params.session_id)
                .map_err(error)?,
        )
    }

    pub(super) fn submit(
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
        self.diagnostics
            .submit(connection.connection_id, params)
            .map_err(error)?;
        result(&())
    }

    pub(super) fn export(
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
            .diagnostics
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

#[cfg(test)]
#[path = "memory_diagnostics_tests.rs"]
mod tests;
