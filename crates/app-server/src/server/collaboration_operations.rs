use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationOpenParams;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationPresenceParams;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationPresenceReadParams;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationSubmitParams;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationSubmitResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;

impl AppServer {
    pub(super) fn document_collaboration_open(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DocumentCollaborationOpenParams = decode(params)?;
        let opened = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .open(params)
            .map_err(invalid_collaboration_params)?;
        self.updates.subscribe_document_collaboration(
            connection.connection_id,
            opened.snapshot.room_id.clone(),
        );
        result(&opened)
    }

    pub(super) fn document_collaboration_submit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: DocumentCollaborationSubmitParams = decode(params)?;
        let submitted = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .submit(params)
            .map_err(invalid_collaboration_params)?;
        if let DocumentCollaborationSubmitResult::Accepted { update } = &submitted {
            self.updates.publish_document_collaboration(update.clone());
        }
        result(&submitted)
    }

    pub(super) fn document_collaboration_presence_publish(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DocumentCollaborationPresenceParams = decode(params)?;
        let snapshot = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .publish_presence(params)
            .map_err(invalid_collaboration_params)?;
        self.updates
            .publish_document_collaboration_presence(snapshot.clone());
        result(&snapshot)
    }

    pub(super) fn document_collaboration_presence_read(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DocumentCollaborationPresenceReadParams = decode(params)?;
        let snapshot = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .read_presence(params)
            .map_err(invalid_collaboration_params)?;
        result(&snapshot)
    }
}

fn invalid_collaboration_params(_error: String) -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn collaboration_error() -> RpcError {
    RpcError::new(-32603, AppServerErrorName::InternalError)
}
