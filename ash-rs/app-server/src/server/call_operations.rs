use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::call::CallControlParams;
use ash_app_server_protocol::protocol::call::CallEndParams;
use ash_app_server_protocol::protocol::call::CallInvitation;
use ash_app_server_protocol::protocol::call::CallInviteParams;
use ash_app_server_protocol::protocol::call::CallMemberParams;
use ash_app_server_protocol::protocol::call::CallResourceParams;
use ash_app_server_protocol::protocol::call::CallRoleParams;
use ash_app_server_protocol::protocol::call::CallStartParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use serde_json::Value;

impl AppServer {
    pub(super) fn call_operation(
        &self,
        connection: &ConnectionState,
        method: ClientMethod,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let state = connection
            .state
            .lock()
            .map_err(|_| failure("Connection state unavailable".into()))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let owner = connection.connection_id;
        match method {
            ClientMethod::CallStart => {
                let params: CallStartParams = decode(params)?;
                let home = self
                    .home
                    .as_ref()
                    .ok_or_else(|| failure("Call storage unavailable".into()))?;
                result(
                    &self
                        .calls
                        .start(
                            owner,
                            params,
                            home.root(),
                            connection.outbound_notifications.clone(),
                        )
                        .map_err(failure)?,
                )
            }
            ClientMethod::CallControl => {
                let params: CallControlParams = decode(params)?;
                result(
                    &self
                        .calls
                        .control(owner, &params.resource_id, Some(params.control))
                        .map_err(failure)?,
                )
            }
            ClientMethod::CallLeave => {
                let params: CallResourceParams = decode(params)?;
                result(
                    &self
                        .calls
                        .control(owner, &params.resource_id, None)
                        .map_err(failure)?,
                )
            }
            ClientMethod::CallRead | ClientMethod::CallEnd => {
                let ending: Option<CallEndParams> = if method == ClientMethod::CallEnd {
                    Some(decode(params)?)
                } else {
                    None
                };
                let params: CallResourceParams = if let Some(ending) = &ending {
                    CallResourceParams {
                        resource_id: ending.resource_id.clone(),
                    }
                } else {
                    decode(params)?
                };
                let (client, snapshot) = {
                    let sessions = self
                        .calls
                        .sessions
                        .lock()
                        .map_err(|_| failure("Call state unavailable".into()))?;
                    let session = sessions
                        .get(&(owner, params.resource_id.clone()))
                        .ok_or_else(|| failure("Call not found".into()))?;
                    let snapshot = session
                        .state
                        .lock()
                        .map_err(|_| failure("Call state unavailable".into()))?
                        .clone();
                    (session.client.clone(), snapshot)
                };
                if let Some(ending) = ending {
                    client
                        .end(&ending.operation_id, ending.revision)
                        .map_err(|e| failure(e.to_string()))?;
                    result(
                        &self
                            .calls
                            .control(owner, &params.resource_id, None)
                            .map_err(failure)?,
                    )
                } else {
                    result(&snapshot)
                }
            }
            ClientMethod::CallInvite => {
                let params: CallInviteParams = decode(params)?;
                if matches!(params.role, call::CallRole::Owner | call::CallRole::Agent) {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let mut sessions = self
                    .calls
                    .sessions
                    .lock()
                    .map_err(|_| failure("Call state unavailable".into()))?;
                let session = sessions
                    .get_mut(&(owner, params.resource_id))
                    .ok_or_else(|| failure("Call not found".into()))?;
                if let Some((role, revision, _)) = session.invitations.get(&params.operation_id) {
                    if *role != params.role || *revision != params.revision {
                        return Err(RpcError::new(-32004, AppServerErrorName::CommandConflict));
                    }
                } else {
                    session.invitations.insert(
                        params.operation_id.clone(),
                        (
                            params.role,
                            params.revision,
                            call::MemberCredential::generate().expose().to_owned(),
                        ),
                    );
                }
                let credential = session.invitations[&params.operation_id].2.clone();
                let secret = call::MemberCredential::parse(credential.clone())
                    .map_err(|e| failure(e.to_string()))?;
                session
                    .client
                    .invite(&params.operation_id, params.revision, &secret, params.role)
                    .map_err(|e| failure(e.to_string()))?;
                result(&CallInvitation {
                    url: session.url.clone(),
                    credential,
                })
            }
            ClientMethod::CallRemove => {
                let params: CallMemberParams = decode(params)?;
                let sessions = self
                    .calls
                    .sessions
                    .lock()
                    .map_err(|_| failure("Call state unavailable".into()))?;
                let session = sessions
                    .get(&(owner, params.resource_id))
                    .ok_or_else(|| failure("Call not found".into()))?;
                session
                    .client
                    .remove(&params.operation_id, params.revision, &params.member_id)
                    .map_err(|e| failure(e.to_string()))?;
                result(
                    &*session
                        .state
                        .lock()
                        .map_err(|_| failure("Call state unavailable".into()))?,
                )
            }
            ClientMethod::CallRole => {
                let params: CallRoleParams = decode(params)?;
                let sessions = self
                    .calls
                    .sessions
                    .lock()
                    .map_err(|_| failure("Call state unavailable".into()))?;
                let session = sessions
                    .get(&(owner, params.resource_id))
                    .ok_or_else(|| failure("Call not found".into()))?;
                session
                    .client
                    .set_role(
                        &params.operation_id,
                        params.revision,
                        &params.member_id,
                        params.role,
                    )
                    .map_err(|e| failure(e.to_string()))?;
                result(
                    &*session
                        .state
                        .lock()
                        .map_err(|_| failure("Call state unavailable".into()))?,
                )
            }
            _ => Err(RpcError::new(-32601, AppServerErrorName::MethodNotFound)),
        }
    }
}

fn failure(detail: String) -> RpcError {
    RpcError {
        code: -32070,
        message: AppServerErrorName::CallOperationFailed,
        detail: Some(detail),
    }
}
