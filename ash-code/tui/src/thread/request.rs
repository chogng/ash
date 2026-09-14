use crate::client::new_command_id;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::ChatSubmission;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::attachments::AttachmentImportRemoteParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadCancelParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadFinishParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadStartParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadWriteParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::protocol::turn::TurnInteractionResolveResult;
use ash_app_server_protocol::protocol::turn::TurnInterruptResult;
use ash_app_server_protocol::protocol::turn::TurnStartResult;
use ash_app_server_protocol::protocol::turn::TurnSteerResult;
use ash_protocol::AgentResponse;
use ash_protocol::ApprovalMode;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ThreadRequestKind {
    Approval,
    Query,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ThreadRequestIdentity {
    pub(crate) kind: ThreadRequestKind,
    pub(crate) request_id: RequestId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ThreadRequestResponse {
    pub(crate) kind: ThreadRequestKind,
    pub(crate) turn_id: TurnId,
    pub(crate) request_id: RequestId,
    pub(crate) response: AgentResponse,
}

impl ThreadRequestResponse {
    pub(crate) fn identity(&self) -> ThreadRequestIdentity {
        ThreadRequestIdentity {
            kind: self.kind,
            request_id: self.request_id.clone(),
        }
    }
}

/// Identifies the aggregate and canonical sequence used by one typed Thread request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ThreadRequestScope {
    session_id: SessionId,
    thread_id: ThreadId,
    expected_sequence: u64,
}

impl ThreadRequestScope {
    pub(crate) fn new(
        session_id: &SessionId,
        thread_id: &ThreadId,
        expected_sequence: u64,
    ) -> Self {
        Self {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            expected_sequence,
        }
    }

    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub(crate) fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }

    pub(crate) fn targets(&self, session_id: &SessionId, thread_id: &ThreadId) -> bool {
        self.session_id == *session_id && self.thread_id == *thread_id
    }
}

pub(super) fn validate_thread_scope(
    thread: &Thread,
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<(), ClientError> {
    if thread.session_id == *session_id && thread.thread_id == *thread_id {
        return Ok(());
    }
    Err(ClientError::Protocol(format!(
        "thread read returned snapshot for {}/{}; expected {session_id}/{thread_id}",
        thread.session_id, thread.thread_id
    )))
}

pub(super) fn validate_transcript_scope(
    transcript: &ThreadTranscriptSnapshot,
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<(), ClientError> {
    if transcript.session_id == *session_id && transcript.thread_id == *thread_id {
        return Ok(());
    }
    Err(ClientError::Protocol(format!(
        "thread read returned transcript for {}/{}; expected {session_id}/{thread_id}",
        transcript.session_id, transcript.thread_id
    )))
}

pub(crate) fn submit_prompt<T>(
    client: &mut AppServerClient<T>,
    scope: ThreadRequestScope,
    submission: ChatSubmission,
    approval_mode: ApprovalMode,
) -> Result<TurnStartResult, ClientError>
where
    T: JsonRpcTransport,
{
    let input = materialize_submission(client, submission)?;
    match client.request_session(SessionRequestParams {
        command_id: new_command_id("turn"),
        session_id: scope.session_id,
        request: SessionRequest::StartTurn {
            thread_id: scope.thread_id,
            expected_sequence: scope.expected_sequence,
            approval_mode,
            tool_mode: None,
            input,
        },
    })? {
        SessionRequestResult::Turn(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for StartTurn"
        ))),
    }
}

pub(crate) fn steer_prompt<T>(
    client: &mut AppServerClient<T>,
    scope: ThreadRequestScope,
    turn_id: TurnId,
    submission: ChatSubmission,
) -> Result<TurnSteerResult, ClientError>
where
    T: JsonRpcTransport,
{
    let input = materialize_submission(client, submission)?;
    match client.request_session(SessionRequestParams {
        command_id: new_command_id("steer"),
        session_id: scope.session_id,
        request: SessionRequest::SteerTurn {
            thread_id: scope.thread_id,
            expected_sequence: scope.expected_sequence,
            turn_id,
            input,
        },
    })? {
        SessionRequestResult::TurnSteer(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for SteerTurn"
        ))),
    }
}

pub(super) fn materialize_submission<T>(
    client: &mut AppServerClient<T>,
    submission: ChatSubmission,
) -> Result<Vec<InputItem>, ClientError>
where
    T: JsonRpcTransport,
{
    let mut input = Vec::with_capacity(submission.input.len());
    for item in submission.input {
        input.push(match item {
            ChatInputItem::Context {
                name,
                content,
                file_path,
            } => InputItem::Context {
                name,
                content,
                file_path,
            },
            ChatInputItem::Attachment(attachment) => InputItem::ImageAttachment { attachment },
            ChatInputItem::Text(text) => InputItem::Text { text },
            ChatInputItem::Image { url } => InputItem::ImageAttachment {
                attachment: materialize_image(client, &url)?,
            },
            ChatInputItem::Skill { skill } => InputItem::Skill { skill },
            ChatInputItem::Instruction { reference } => InputItem::Instruction { reference },
        });
    }
    Ok(input)
}

fn materialize_image<T>(
    client: &mut AppServerClient<T>,
    url: &str,
) -> Result<ImageAttachmentRef, ClientError>
where
    T: JsonRpcTransport,
{
    if url.starts_with("https://") || url.starts_with("http://") {
        return client
            .import_remote_attachment(AttachmentImportRemoteParams {
                url: url.to_owned(),
                detail: ImageDetail::Auto,
            })
            .map(|result| result.attachment);
    }
    let (media_type, bytes) = decode_image_data_url(url)?;
    let started = client.start_attachment_upload(AttachmentUploadStartParams {
        media_type,
        encoded_bytes: bytes.len() as u64,
        detail: ImageDetail::Auto,
    })?;
    let upload_id = started.upload_id;
    let upload_result = (|| {
        let mut offset = 0usize;
        for chunk in bytes.chunks(started.max_chunk_bytes) {
            let written = client.write_attachment_upload(AttachmentUploadWriteParams {
                upload_id: upload_id.clone(),
                offset: offset as u64,
                data_base64: STANDARD.encode(chunk),
            })?;
            offset = usize::try_from(written.next_offset).map_err(|_| {
                ClientError::Protocol("attachment upload offset exceeds this platform".into())
            })?;
        }
        client
            .finish_attachment_upload(AttachmentUploadFinishParams {
                upload_id: upload_id.clone(),
            })
            .map(|result| result.attachment)
    })();
    if upload_result.is_err() {
        let _ = client.cancel_attachment_upload(AttachmentUploadCancelParams { upload_id });
    }
    upload_result
}

fn decode_image_data_url(url: &str) -> Result<(ImageMediaType, Vec<u8>), ClientError> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| ClientError::Protocol("chat_input image is not a data URL".into()))?;
    let (metadata, encoded) = rest
        .split_once(',')
        .ok_or_else(|| ClientError::Protocol("chat_input image data URL is malformed".into()))?;
    let mut metadata = metadata.split(';');
    let media_type = match metadata.next() {
        Some("image/png") => ImageMediaType::Png,
        Some("image/jpeg") => ImageMediaType::Jpeg,
        Some("image/gif") => ImageMediaType::Gif,
        Some("image/webp") => ImageMediaType::WebP,
        _ => {
            return Err(ClientError::Protocol(
                "chat_input image MIME type is unsupported".into(),
            ));
        }
    };
    if !metadata.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Err(ClientError::Protocol(
            "chat_input image data URL must use base64".into(),
        ));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ClientError::Protocol("chat_input image base64 is invalid".into()))?;
    Ok((media_type, bytes))
}

#[cfg(test)]
pub(crate) fn read_thread<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<Thread, ClientError>
where
    T: JsonRpcTransport,
{
    let result = client.read_session_thread(SessionThreadReadParams {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        history: None,
    })?;
    validate_thread_scope(&result.thread, session_id, thread_id)?;
    Ok(result.thread)
}

pub(crate) struct LatestThreadSnapshot {
    pub(crate) thread: Thread,
    pub(crate) transcript: ThreadTranscriptSnapshot,
    pub(crate) boundary: ThreadHistoryBoundary,
}

pub(crate) fn read_thread_history<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    thread_id: &ThreadId,
    history: ThreadSnapshotHistory,
) -> Result<LatestThreadSnapshot, ClientError>
where
    T: JsonRpcTransport,
{
    let result = client.read_session_thread(SessionThreadReadParams {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        history: Some(history),
    })?;
    validate_thread_scope(&result.thread, session_id, thread_id)?;
    validate_transcript_scope(&result.transcript, session_id, thread_id)?;
    let boundary = require_history_boundary(result.history)?;
    Ok(LatestThreadSnapshot {
        thread: result.thread,
        transcript: result.transcript,
        boundary,
    })
}

pub(crate) struct OlderThreadHistoryPage {
    pub(crate) thread: Thread,
    pub(crate) transcript: ThreadTranscriptSnapshot,
    pub(crate) boundary: ThreadHistoryBoundary,
}

pub(crate) fn read_older_thread_history<T>(
    client: &mut AppServerClient<T>,
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: ash_protocol::TurnId,
) -> Result<OlderThreadHistoryPage, ClientError>
where
    T: JsonRpcTransport,
{
    let result = client.read_session_thread(SessionThreadReadParams {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        history: Some(ThreadSnapshotHistory::Before {
            turn_id,
            turn_limit: 50,
        }),
    })?;
    validate_thread_scope(&result.thread, session_id, thread_id)?;
    validate_transcript_scope(&result.transcript, session_id, thread_id)?;
    let boundary = require_history_boundary(result.history)?;
    Ok(OlderThreadHistoryPage {
        thread: result.thread,
        transcript: result.transcript,
        boundary,
    })
}

pub(super) fn require_history_boundary(
    boundary: Option<ThreadHistoryBoundary>,
) -> Result<ThreadHistoryBoundary, ClientError> {
    boundary.ok_or_else(|| {
        ClientError::Protocol("bounded Thread snapshot omitted its history boundary".into())
    })
}

pub(crate) fn interrupt_turn<T>(
    client: &mut AppServerClient<T>,
    scope: ThreadRequestScope,
    turn_id: &TurnId,
) -> Result<TurnInterruptResult, ClientError>
where
    T: JsonRpcTransport,
{
    match client.request_session(SessionRequestParams {
        command_id: new_command_id("interrupt"),
        session_id: scope.session_id,
        request: SessionRequest::InterruptTurn {
            thread_id: scope.thread_id,
            expected_sequence: scope.expected_sequence,
            turn_id: turn_id.clone(),
        },
    })? {
        SessionRequestResult::TurnInterrupt(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for InterruptTurn"
        ))),
    }
}

pub(crate) fn resolve_interaction<T>(
    client: &mut AppServerClient<T>,
    scope: ThreadRequestScope,
    turn_id: TurnId,
    request_id: RequestId,
    response: AgentResponse,
) -> Result<TurnInteractionResolveResult, ClientError>
where
    T: JsonRpcTransport,
{
    match client.request_session(SessionRequestParams {
        command_id: new_command_id("interaction"),
        session_id: scope.session_id,
        request: SessionRequest::ResolveInteraction {
            thread_id: scope.thread_id,
            expected_sequence: scope.expected_sequence,
            turn_id,
            request_id,
            response,
        },
    })? {
        SessionRequestResult::Interaction(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for ResolveInteraction"
        ))),
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
