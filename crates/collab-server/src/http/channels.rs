use super::CollaborationServerError;
use super::HttpRequest;
use super::HttpRuntime;
use ash_collab::channels::ChannelCreate;
use ash_collab::channels::ChannelCredential;
use ash_collab::channels::ChannelEditParams;
use ash_collab::channels::ChannelError;
use ash_collab::channels::ChannelInvite;
use serde_json::Value;
use serde_json::json;
use std::net::TcpStream;

pub(super) fn handle(
    stream: &mut TcpStream,
    host: &HttpRuntime,
    request: &HttpRequest,
    path: &str,
) -> Result<(), CollaborationServerError> {
    let result = dispatch(host, request, path);
    let (status, reason, body) = match result {
        Ok(body) => (200, "OK", body),
        Err(error) => {
            let (status, reason, code) = match error {
                ChannelError::Invalid => (400, "Bad Request", "invalidInput"),
                ChannelError::Denied => (403, "Forbidden", "accessDenied"),
                ChannelError::Conflict => (409, "Conflict", "revisionConflict"),
                ChannelError::Storage => (500, "Internal Server Error", "storageFailure"),
                ChannelError::Transport => (503, "Service Unavailable", "transportFailure"),
            };
            (status, reason, json!({"error":{"code":code}}))
        }
    };
    super::write_json(stream, host, request, status, reason, &body)
}

fn dispatch(host: &HttpRuntime, request: &HttpRequest, path: &str) -> Result<Value, ChannelError> {
    let token = super::bearer_token(request).ok_or(ChannelError::Denied)?;
    let snapshot = if request.method == "POST" && path == "/v1/channels/create" {
        if !super::authorized(request, host.options.bearer_token()) {
            return Err(ChannelError::Denied);
        }
        let params: ChannelCreate =
            serde_json::from_slice(&request.body).map_err(|_| ChannelError::Invalid)?;
        host.channels.create(
            &ChannelCredential::parse(params.credential)?,
            &params.name,
            &params.member_name,
        )?
    } else {
        let credential =
            ChannelCredential::parse(token.into()).map_err(|_| ChannelError::Denied)?;
        if request.method == "POST" && matches!(path, "/v1/channels/notes" | "/v1/channels/call") {
            let params =
                serde_json::from_slice(&request.body).map_err(|_| ChannelError::Invalid)?;
            let kind = if path.ends_with("/notes") {
                ash_collab::channels::ChannelResourceKind::Notes
            } else {
                ash_collab::channels::ChannelResourceKind::Call
            };
            let access = host.channels.resource(&credential, params, kind)?;
            if path.ends_with("/call") {
                host.calls
                    .as_ref()
                    .ok_or(ChannelError::Transport)?
                    .open_channel(&access.credential)?;
                host.updates.notify();
            }
            return serde_json::to_value(access).map_err(|_| ChannelError::Storage);
        }
        match (request.method.as_str(), path) {
            ("GET", "/v1/channels/read") => host.channels.read(&credential)?,
            ("POST", "/v1/channels/edit") => {
                let edit: ChannelEditParams =
                    serde_json::from_slice(&request.body).map_err(|_| ChannelError::Invalid)?;
                host.channels.edit(&credential, edit)?
            }
            ("POST", "/v1/channels/invite") => {
                let invite: ChannelInvite =
                    serde_json::from_slice(&request.body).map_err(|_| ChannelError::Invalid)?;
                host.channels.invite(&credential, invite)?
            }
            _ => return Err(ChannelError::Invalid),
        }
    };
    serde_json::to_value(snapshot).map_err(|_| ChannelError::Storage)
}
