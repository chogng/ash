use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::collaboration::RoomOpenParams;
use ash_app_server_protocol::protocol::collaboration::RoomPresenceParams;
use ash_app_server_protocol::protocol::collaboration::RoomPresenceReadParams;
use ash_app_server_protocol::protocol::collaboration::RoomSubmitParams;
use ash_app_server_protocol::protocol::collaboration::RoomSubmitResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;

/// Owns collaboration rooms while the broker owns connection subscriptions and delivery.
pub(super) struct CollaborationRequestProcessor {
    collaboration: std::sync::Mutex<super::collaboration_runtime::MemoryRoomStore>,
    updates: std::sync::Arc<super::update_broker::UpdateBroker>,
}

impl CollaborationRequestProcessor {
    pub(super) fn new(updates: std::sync::Arc<super::update_broker::UpdateBroker>) -> Self {
        Self {
            collaboration: std::sync::Mutex::new(Default::default()),
            updates,
        }
    }

    pub(super) fn room_status(&self, params: &Value) -> Result<Value, RpcError> {
        let params = decode(params)?;
        let status = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .status(params)
            .map_err(invalid_collaboration_params)?;
        result(&status)
    }

    pub(super) fn room_open(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: RoomOpenParams = decode(params)?;
        let opened = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .open(params)
            .map_err(invalid_collaboration_params)?;
        self.updates
            .subscribe_room(connection.connection_id, opened.snapshot.room_id.clone());
        result(&opened)
    }

    pub(super) fn room_submit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: RoomSubmitParams = decode(params)?;
        let submitted = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .submit(params)
            .map_err(invalid_collaboration_params)?;
        if let RoomSubmitResult::Accepted { update } = &submitted {
            self.updates.publish_room(update.clone());
        }
        result(&submitted)
    }

    pub(super) fn room_presence_publish(&self, params: &Value) -> Result<Value, RpcError> {
        let params: RoomPresenceParams = decode(params)?;
        let snapshot = self
            .collaboration
            .lock()
            .map_err(|_| collaboration_error())?
            .publish_presence(params)
            .map_err(invalid_collaboration_params)?;
        self.updates.publish_room_presence(snapshot.clone());
        result(&snapshot)
    }

    pub(super) fn room_presence_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: RoomPresenceReadParams = decode(params)?;
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
