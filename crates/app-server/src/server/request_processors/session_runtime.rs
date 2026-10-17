use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;
use std::sync::Arc;

/// Adapts provider invocation and connection-scoped operation cancellation.
pub(super) struct SessionRuntimeRequestProcessor<'a> {
    request_cancellations: &'a super::RequestCancellationRegistry,
    request_scheduler: &'a super::RequestScheduler,
}
impl<'a> SessionRuntimeRequestProcessor<'a> {
    pub(super) fn new(
        request_cancellations: &'a super::RequestCancellationRegistry,
        request_scheduler: &'a super::RequestScheduler,
    ) -> Self {
        Self {
            request_cancellations,
            request_scheduler,
        }
    }
    pub(super) fn invoke(
        runtimes: Option<&Arc<crate::session_runtime_provider::SessionRuntimeProvider>>,
        params: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::session::SessionRuntimeParams =
            decode(params)?;
        let runtimes =
            runtimes.ok_or_else(|| RpcError::new(-32601, AppServerErrorName::MethodNotFound))?;
        let value = runtimes
            .invoke(&params.provider_id, params.request, cancellation)
            .map_err(|error| {
                RpcError::with_details(-32603, AppServerErrorName::InternalError, error)
            })?;
        result(&value)
    }
    pub(super) fn cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::session::SessionRuntimeCancelParams =
            decode(params)?;
        if params.operation_id.is_empty() || params.operation_id.len() > 128 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.request_scheduler.cancel_waiting_requests();
        result(&())
    }
}
