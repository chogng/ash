use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::dictation::DictationResourceParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;

impl AppServer {
    pub(super) fn dictation_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let params: DictationResourceParams = decode(params)?;
        self.dictation
            .start(
                connection.connection_id,
                params.resource_id,
                connection.outbound_notifications.clone(),
            )
            .map_err(dictation_error)?;
        result(&())
    }

    pub(super) fn dictation_stop(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DictationResourceParams = decode(params)?;
        self.dictation
            .stop(connection.connection_id, &params.resource_id)
            .map_err(dictation_error)?;
        result(&())
    }
}

fn dictation_error(detail: String) -> RpcError {
    let mut error = RpcError::new(-32000, AppServerErrorName::InternalError);
    error.detail = Some(detail);
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::ProviderModelService;
    use ash_core::{InMemoryThreadStore, ThreadController};
    use ash_model_provider::EchoModel;
    use std::sync::Arc;

    #[test]
    fn dictation_requires_product_authority_and_rejects_invalid_resource_ids() {
        let server = AppServer::new(
            Arc::new(ThreadController::with_store(Arc::new(
                InMemoryThreadStore::default(),
            ))),
            Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        );
        let mut client = server.connection();
        let mut host = server.product_host_connection();
        for connection in [&mut client, &mut host] {
            let response: serde_json::Value = serde_json::from_str(&server.handle_json(connection,
                &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"dictation-test","version":"1"},"capabilities":{}}}).to_string())).unwrap();
            assert!(response.get("result").is_some());
        }
        let request = serde_json::json!({"jsonrpc":"2.0", "id":2, "method":"dictation/start", "params":{"resourceId":"bad/id"}}).to_string();
        let denied: serde_json::Value =
            serde_json::from_str(&server.handle_json(&mut client, &request)).unwrap();
        assert_eq!(denied["error"]["message"], "PermissionRequired");
        let rejected: serde_json::Value =
            serde_json::from_str(&server.handle_json(&mut host, &request)).unwrap();
        assert_eq!(
            rejected["error"]["message"],
            "InternalError: Invalid dictation resource ID"
        );
    }
}
