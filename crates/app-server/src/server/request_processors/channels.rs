use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_collab::channel_client::ChannelAccount;
use ash_collab::channels::ChannelError;
use serde_json::Value;

pub(super) fn execute(
    account: &ChannelAccount,
    connection: &ConnectionState,
    method: ClientMethod,
    params: &Value,
) -> Result<Value, RpcError> {
    // Saved channel credentials belong to the local user, not remote directory grantees.
    if !matches!(
        connection.authority,
        super::ConnectionAuthority::ProductHost | super::ConnectionAuthority::Browser
    ) {
        return Err(RpcError::new(
            -32073,
            AppServerErrorName::PermissionRequired,
        ));
    }
    match method {
        ClientMethod::ChannelNotes => result(
            &account
                .resource(
                    decode(params)?,
                    ash_collab::channels::ChannelResourceKind::Notes,
                )
                .map_err(failure)?,
        ),
        ClientMethod::ChannelCall => result(
            &account
                .resource(
                    decode(params)?,
                    ash_collab::channels::ChannelResourceKind::Call,
                )
                .map_err(failure)?,
        ),
        ClientMethod::ChannelConnect => result(&account.connect(decode(params)?).map_err(failure)?),
        ClientMethod::ChannelEdit => result(&account.edit(decode(params)?).map_err(failure)?),
        ClientMethod::ChannelInvite => result(&account.invite(decode(params)?).map_err(failure)?),
        ClientMethod::ChannelRead => {
            let _: EmptyParams = decode(params)?;
            result(&account.read().map_err(failure)?)
        }
        ClientMethod::ChannelSignInKey => {
            let _: EmptyParams = decode(params)?;
            result(&account.sign_in_key().map_err(failure)?)
        }
        ClientMethod::ChannelDisconnect => {
            let _: EmptyParams = decode(params)?;
            result(&account.disconnect().map_err(failure)?)
        }
        _ => Err(RpcError::new(-32601, AppServerErrorName::MethodNotFound)),
    }
}
fn failure(error: ChannelError) -> RpcError {
    let name = match error {
        ChannelError::Invalid => AppServerErrorName::ChannelInvalid,
        ChannelError::Denied => AppServerErrorName::ChannelDenied,
        ChannelError::Conflict => AppServerErrorName::ChannelConflict,
        ChannelError::Storage => AppServerErrorName::ChannelStorage,
        ChannelError::Transport => AppServerErrorName::ChannelTransport,
    };
    RpcError::new(-32074, name)
}
