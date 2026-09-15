use crate::ApiError;
use crate::ModelUsage;
use crate::ToolCall;
use crate::ToolCallId;
use crate::ToolDefinition;
use crate::ToolName;
use crate::WebSocketSessionConfig;
use crate::websocket::JsonSocket;
use ash_async_utils::CancellationToken;
use ash_client::ResolvedApiTarget;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketRequest;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use serde_json::json;

/// Realtime output is either text or PCM16 mono audio at 24 kHz.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RealtimeOutput {
    Text,
    Audio { voice: String },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealtimeTurnDetection {
    Manual,
    ServerVad,
}

/// Explicit GA session settings. Audio capture, resampling, and playback belong to the host.
#[derive(Clone, Debug)]
pub struct RealtimeConfig {
    pub instructions: String,
    pub output: RealtimeOutput,
    pub turn_detection: RealtimeTurnDetection,
    pub tools: Vec<ToolDefinition>,
}
impl Default for RealtimeConfig {
    fn default() -> Self {
        Self {
            instructions: String::new(),
            output: RealtimeOutput::Text,
            turn_detection: RealtimeTurnDetection::Manual,
            tools: Vec::new(),
        }
    }
}

/// Commands for the public Realtime GA contract; none executes tools on the caller's behalf.
#[derive(Clone, Debug)]
pub enum RealtimeCommand {
    Configure(RealtimeConfig),
    UserText { text: String },
    AppendAudio { pcm16: Vec<u8> },
    CommitAudio,
    ClearAudio,
    CreateResponse,
    CancelResponse,
    ToolResult { call_id: ToolCallId, output: String },
    TruncateAudio { item_id: String, played_ms: u32 },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealtimeResponseStatus {
    Completed,
    Cancelled,
    Failed,
    Incomplete,
}

/// Ordered model events. Generated audio and response completion do not confirm playback.
#[derive(Clone, Debug, PartialEq)]
pub enum RealtimeEvent {
    SessionUpdated,
    ResponseCreated {
        response_id: String,
    },
    TextDelta {
        response_id: String,
        item_id: String,
        text: String,
    },
    AudioDelta {
        response_id: String,
        item_id: String,
        pcm16: Vec<u8>,
    },
    OutputTranscriptDelta {
        response_id: String,
        item_id: String,
        text: String,
    },
    InputTranscriptDelta {
        item_id: String,
        text: String,
    },
    InputTranscriptCompleted {
        item_id: String,
        text: String,
    },
    SpeechStarted {
        item_id: String,
    },
    SpeechStopped {
        item_id: String,
    },
    ToolCall {
        response_id: String,
        call: ToolCall,
    },
    ResponseDone {
        response_id: String,
        status: RealtimeResponseStatus,
        usage: Option<ModelUsage>,
    },
    Error {
        kind: String,
        code: Option<String>,
        event_id: Option<String>,
    },
    /// An optional event the caller may ignore; raw server payloads are not forwarded.
    Other {
        event_type: String,
    },
}

/// A caller-owned bidirectional Realtime session with one active default-conversation response.
/// Hosts can select between `receive` and their microphone/input queue in one async event loop.
pub struct RealtimeSession {
    socket: Option<JsonSocket>,
    session_id: String,
    response_id: Option<String>,
    response_requested: Option<String>,
    next_event: u64,
    audio_started: bool,
    voice: Option<String>,
    max_event_bytes: usize,
}
impl RealtimeSession {
    pub async fn connect(
        connector: &WebSocketConnector,
        target: &ResolvedApiTarget,
        model: &str,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<Self, ApiError> {
        if model.trim().is_empty() {
            return Err(ApiError::InvalidRequest(
                "Realtime model must not be empty".into(),
            ));
        }
        let mut url = crate::websocket::url(&target.base_url, "realtime")?;
        url.query_pairs_mut().append_pair("model", model);
        let mut headers = Vec::new();
        for header in &target.headers {
            if header.name().eq_ignore_ascii_case("openai-beta") {
                return Err(ApiError::InvalidRequest(
                    "Realtime GA does not accept a beta handshake profile".into(),
                ));
            }
            crate::headers::insert(&mut headers, header.name(), header.value())?;
        }
        let wire = WebSocketRequest::new(url.as_str(), headers)
            .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
        let (mut socket, _) = JsonSocket::connect(connector, wire, limits, cancellation).await?;
        let created = socket.receive(cancellation).await?;
        if created["type"] != "session.created" || created["session"]["type"] != "realtime" {
            return Err(ApiError::InvalidResponse(
                "Realtime GA session.created was not received".into(),
            ));
        }
        let session_id = required(&created["session"], "id")?.to_owned();
        Ok(Self {
            socket: Some(socket),
            session_id,
            response_id: None,
            response_requested: None,
            next_event: 0,
            audio_started: false,
            voice: created
                .pointer("/session/audio/output/voice")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            max_event_bytes: limits.max_event_bytes,
        })
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn is_open(&self) -> bool {
        self.socket.is_some()
    }
    pub fn abort(&mut self) {
        self.socket = None;
        self.response_id = None;
        self.response_requested = None;
    }
    pub async fn close(&mut self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.response_id = None;
        self.response_requested = None;
        if let Some(socket) = self.socket.take() {
            socket.shutdown(cancellation).await?;
        }
        Ok(())
    }

    pub async fn send(
        &mut self,
        command: RealtimeCommand,
        cancellation: &CancellationToken,
    ) -> Result<(), ApiError> {
        cancellation
            .check()
            .map_err(|_| crate::websocket::cancelled())?;
        let creates_response = matches!(command, RealtimeCommand::CreateResponse);
        if creates_response && (self.response_requested.is_some() || self.response_id.is_some()) {
            return Err(ApiError::InvalidRequest(
                "a Realtime response is already active".into(),
            ));
        }
        if matches!(command, RealtimeCommand::CancelResponse)
            && self.response_requested.is_none()
            && self.response_id.is_none()
        {
            return Err(ApiError::InvalidRequest(
                "there is no Realtime response to cancel".into(),
            ));
        }
        let mut value = match &command {
            RealtimeCommand::Configure(config) => {
                if let RealtimeOutput::Audio { voice } = &config.output {
                    if voice.trim().is_empty()
                        || self.audio_started && self.voice.as_ref() != Some(voice)
                    {
                        return Err(ApiError::InvalidRequest(
                            "Realtime voice cannot change after audio output".into(),
                        ));
                    }
                }
                session_update(config)?
            }
            RealtimeCommand::UserText { text } => {
                json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
            }
            RealtimeCommand::AppendAudio { pcm16 } => {
                if pcm16.is_empty()
                    || pcm16.len() % 2 != 0
                    || pcm16.len() > self.max_event_bytes / 2
                {
                    return Err(ApiError::InvalidRequest(
                        "audio must contain bounded complete PCM16 samples".into(),
                    ));
                }
                json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(pcm16)})
            }
            RealtimeCommand::CommitAudio => json!({"type":"input_audio_buffer.commit"}),
            RealtimeCommand::ClearAudio => json!({"type":"input_audio_buffer.clear"}),
            RealtimeCommand::CreateResponse => json!({"type":"response.create"}),
            RealtimeCommand::CancelResponse => {
                let mut event = json!({"type":"response.cancel"});
                if let Some(id) = &self.response_id {
                    event["response_id"] = json!(id);
                }
                event
            }
            RealtimeCommand::ToolResult { call_id, output } => {
                json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}})
            }
            RealtimeCommand::TruncateAudio { item_id, played_ms } => {
                if item_id.is_empty() {
                    return Err(ApiError::InvalidRequest(
                        "audio item ID must not be empty".into(),
                    ));
                }
                json!({"type":"conversation.item.truncate","item_id":item_id,"content_index":0,"audio_end_ms":played_ms})
            }
        };
        self.next_event = self
            .next_event
            .checked_add(1)
            .ok_or_else(|| ApiError::InvalidRequest("Realtime event counter exhausted".into()))?;
        let event_id = format!("ash-realtime-{}", self.next_event);
        value["event_id"] = json!(event_id);
        let mut socket = self
            .socket
            .take()
            .ok_or_else(|| ApiError::Transport("Realtime session is closed".into()))?;
        socket.send(value, cancellation).await?;
        self.socket = Some(socket);
        if creates_response {
            self.response_requested = Some(event_id);
        }
        Ok(())
    }

    /// Cancellation closes the session. Dropping only the receive future preserves the socket,
    /// allowing the host to alternate reads with audio sends without a second connection owner.
    pub async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<RealtimeEvent, ApiError> {
        let socket = self
            .socket
            .as_mut()
            .ok_or_else(|| ApiError::Transport("Realtime session is closed".into()))?;
        let result = socket.receive(cancellation).await;
        let event = match result {
            Ok(value) => self.apply(&value),
            Err(error) => Err(error),
        };
        if event.is_err() {
            self.abort();
        }
        event
    }

    fn apply(&mut self, value: &Value) -> Result<RealtimeEvent, ApiError> {
        let kind = required(value, "type")?;
        if let Some(id) = value.get("response_id").and_then(Value::as_str) {
            if self.response_id.as_deref() != Some(id) {
                return Err(ApiError::InvalidResponse(
                    "Realtime event belongs to another response".into(),
                ));
            }
        }
        match kind {
            "session.updated" => {
                if required(&value["session"], "id")? != self.session_id {
                    return Err(ApiError::InvalidResponse(
                        "Realtime session identity changed".into(),
                    ));
                }
                if let Some(voice) = value
                    .pointer("/session/audio/output/voice")
                    .and_then(Value::as_str)
                {
                    self.voice = Some(voice.into());
                }
                Ok(RealtimeEvent::SessionUpdated)
            }
            "response.created" => {
                if self.response_id.is_some() {
                    return Err(ApiError::InvalidResponse(
                        "Realtime created overlapping responses".into(),
                    ));
                }
                let response_id = required(&value["response"], "id")?.to_owned();
                self.response_id = Some(response_id.clone());
                self.response_requested = None;
                Ok(RealtimeEvent::ResponseCreated { response_id })
            }
            "response.output_text.delta" => Ok(RealtimeEvent::TextDelta {
                response_id: required(value, "response_id")?.into(),
                item_id: required(value, "item_id")?.into(),
                text: required_text(value, "delta")?.into(),
            }),
            "response.output_audio.delta" => {
                let audio = STANDARD
                    .decode(required_text(value, "delta")?)
                    .map_err(|_| {
                        ApiError::InvalidResponse("Realtime audio is not base64".into())
                    })?;
                if audio.len() % 2 != 0 {
                    return Err(ApiError::InvalidResponse(
                        "Realtime audio contains incomplete PCM16 samples".into(),
                    ));
                }
                self.audio_started = true;
                Ok(RealtimeEvent::AudioDelta {
                    response_id: required(value, "response_id")?.into(),
                    item_id: required(value, "item_id")?.into(),
                    pcm16: audio,
                })
            }
            "response.output_audio_transcript.delta" => Ok(RealtimeEvent::OutputTranscriptDelta {
                response_id: required(value, "response_id")?.into(),
                item_id: required(value, "item_id")?.into(),
                text: required_text(value, "delta")?.into(),
            }),
            "conversation.item.input_audio_transcription.delta" => {
                Ok(RealtimeEvent::InputTranscriptDelta {
                    item_id: required(value, "item_id")?.into(),
                    text: required_text(value, "delta")?.into(),
                })
            }
            "conversation.item.input_audio_transcription.completed" => {
                Ok(RealtimeEvent::InputTranscriptCompleted {
                    item_id: required(value, "item_id")?.into(),
                    text: required_text(value, "transcript")?.into(),
                })
            }
            "input_audio_buffer.speech_started" => Ok(RealtimeEvent::SpeechStarted {
                item_id: required(value, "item_id")?.into(),
            }),
            "input_audio_buffer.speech_stopped" => Ok(RealtimeEvent::SpeechStopped {
                item_id: required(value, "item_id")?.into(),
            }),
            "response.output_item.done" if value["item"]["type"] == "function_call" => {
                let item = &value["item"];
                let call = ToolCall {
                    id: ToolCallId::new(required(item, "call_id")?).map_err(|_| {
                        ApiError::InvalidResponse("invalid Realtime tool call ID".into())
                    })?,
                    name: ToolName::new(required(item, "name")?).map_err(|_| {
                        ApiError::InvalidResponse("invalid Realtime tool name".into())
                    })?,
                    arguments: serde_json::from_str(required_text(item, "arguments")?).map_err(
                        |_| ApiError::InvalidResponse("invalid Realtime tool arguments".into()),
                    )?,
                };
                Ok(RealtimeEvent::ToolCall {
                    response_id: required(value, "response_id")?.into(),
                    call,
                })
            }
            "response.done" => {
                let response = &value["response"];
                let response_id = required(response, "id")?.to_owned();
                if self.response_id.as_deref() != Some(&response_id) {
                    return Err(ApiError::InvalidResponse(
                        "Realtime completed an unknown response".into(),
                    ));
                }
                let status = match required(response, "status")? {
                    "completed" => RealtimeResponseStatus::Completed,
                    "cancelled" => RealtimeResponseStatus::Cancelled,
                    "failed" => RealtimeResponseStatus::Failed,
                    "incomplete" => RealtimeResponseStatus::Incomplete,
                    _ => {
                        return Err(ApiError::InvalidResponse(
                            "unknown Realtime response status".into(),
                        ));
                    }
                };
                let usage = response
                    .get("usage")
                    .filter(|value| !value.is_null())
                    .map(|usage| ModelUsage {
                        input_tokens: usage["input_tokens"].as_u64(),
                        output_tokens: usage["output_tokens"].as_u64(),
                        cached_input_tokens: usage
                            .pointer("/input_token_details/cached_tokens")
                            .and_then(Value::as_u64),
                        cache_write_input_tokens: None,
                        reasoning_tokens: None,
                    });
                self.response_id = None;
                self.response_requested = None;
                Ok(RealtimeEvent::ResponseDone {
                    response_id,
                    status,
                    usage,
                })
            }
            "error" => {
                let event_id = value["error"]["event_id"].as_str().map(ToOwned::to_owned);
                if event_id.is_some() && event_id == self.response_requested {
                    self.response_requested = None;
                }
                Ok(RealtimeEvent::Error {
                    kind: required(&value["error"], "type")?.into(),
                    code: value["error"]["code"].as_str().map(ToOwned::to_owned),
                    event_id,
                })
            }
            _ => Ok(RealtimeEvent::Other {
                event_type: kind.into(),
            }),
        }
    }
}

fn session_update(config: &RealtimeConfig) -> Result<Value, ApiError> {
    crate::requests::openai_tools::validate_tools(&config.tools)?;
    let mut session = json!({"type":"realtime","instructions":config.instructions,"output_modalities":[match &config.output { RealtimeOutput::Text => "text", RealtimeOutput::Audio { .. } => "audio" }],"tools":config.tools.iter().map(|tool| json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters})).collect::<Vec<_>>(),"tool_choice":if config.tools.is_empty(){"none"}else{"auto"},"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":match config.turn_detection { RealtimeTurnDetection::Manual => Value::Null, RealtimeTurnDetection::ServerVad => json!({"type":"server_vad","create_response":true,"interrupt_response":true}) }}}});
    if let RealtimeOutput::Audio { voice } = &config.output {
        session["audio"]["output"] =
            json!({"format":{"type":"audio/pcm","rate":24000},"voice":voice});
    }
    Ok(json!({"type":"session.update","session":session}))
}
fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    required_text(value, field).and_then(|text| {
        if text.is_empty() {
            Err(ApiError::InvalidResponse(format!(
                "Realtime event has empty {field}"
            )))
        } else {
            Ok(text)
        }
    })
}
fn required_text<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidResponse(format!("Realtime event is missing {field}")))
}
