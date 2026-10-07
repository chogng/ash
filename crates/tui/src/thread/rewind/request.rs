use super::RewindChoices;
use super::rewind_choices;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

pub(crate) fn load_selection<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<RewindChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let thread = client
        .read_session_thread(SessionThreadReadParams {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            history: None,
        })?
        .thread;
    let points = client.message_checkpoints(
        ash_app_server_protocol::protocol::session::MessageCheckpointsParams {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
        },
    )?;
    Ok(rewind_choices(&thread, &points.checkpoints))
}
