use crate::ApiError;
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

/// GPT-Live with application-owned delegation and mono PCM16 at 24 kHz.
#[derive(Clone, Debug)]
pub struct LiveConfig {
    pub instructions: String,
    pub voice: String,
}

#[derive(Clone, Debug)]
pub enum LiveCommand {
    AppendAudio {
        pcm16: Vec<u8>,
    },
    Commentary {
        delegation_id: String,
        content: String,
    },
    Thinking {
        delegation_id: String,
        content: String,
    },
    MuteInput,
    UnmuteInput,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LiveEvent {
    Audio {
        pcm16: Vec<u8>,
    },
    InputTranscript {
        text: String,
        start_ms: u64,
        end_ms: u64,
    },
    OutputTranscript {
        text: String,
        start_ms: u64,
        end_ms: u64,
    },
    Delegation {
        id: String,
        offset_ms: u64,
    },
    Usage {
        seconds: f64,
    },
    Closed {
        reason: String,
        seconds: f64,
    },
    Error {
        code: String,
    },
    Other {
        event_type: String,
    },
}

pub struct LiveSession {
    socket: Option<JsonSocket>,
    session_id: String,
    max_event_bytes: usize,
}

impl LiveSession {
    pub async fn connect(
        connector: &WebSocketConnector,
        target: &ResolvedApiTarget,
        model: &str,
        config: &LiveConfig,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<Self, ApiError> {
        if model.trim().is_empty()
            || config.voice.trim().is_empty()
            || config.instructions.len() > 64 * 1024
        {
            return Err(ApiError::InvalidRequest(
                "invalid Live session configuration".into(),
            ));
        }
        let url = crate::websocket::url(&target.base_url, "live/sessions")?;
        let request = WebSocketRequest::new(url.as_str(), target.headers.clone())
            .map_err(|_| ApiError::InvalidRequest("invalid Live connection headers".into()))?;
        let (mut socket, _) = JsonSocket::connect(connector, request, limits, cancellation).await?;
        socket.send(json!({"type":"session.start","session":{
            "model":model,"instructions":config.instructions,
            "audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":config.voice}},
            "delegation":{"type":"client"},"store":false
        }}), cancellation).await?;
        let started = socket.receive(cancellation).await?;
        if started["type"] != "session.started" {
            return Err(ApiError::InvalidResponse(
                "Live session did not start".into(),
            ));
        }
        let session_id = text(&started["session"], "id")?.to_owned();
        if started["session"]["model"] != model {
            return Err(ApiError::InvalidResponse(
                "Live started a different model".into(),
            ));
        }
        Ok(Self {
            socket: Some(socket),
            session_id,
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
    }

    pub async fn send(
        &mut self,
        command: LiveCommand,
        cancellation: &CancellationToken,
    ) -> Result<(), ApiError> {
        let value = match command {
            LiveCommand::AppendAudio { pcm16 } => {
                if pcm16.is_empty()
                    || pcm16.len() % 2 != 0
                    || pcm16.len() > self.max_event_bytes / 2
                {
                    return Err(ApiError::InvalidRequest(
                        "Live audio must contain bounded PCM16 samples".into(),
                    ));
                }
                json!({"type":"session.input_audio.append","audio":STANDARD.encode(pcm16)})
            }
            LiveCommand::Commentary {
                delegation_id,
                content,
            } => context("session.commentary.append", delegation_id, content)?,
            LiveCommand::Thinking {
                delegation_id,
                content,
            } => context("session.thinking.append", delegation_id, content)?,
            LiveCommand::MuteInput => json!({"type":"session.input_audio.mute"}),
            LiveCommand::UnmuteInput => json!({"type":"session.input_audio.unmute"}),
        };
        // An interrupted send may have written a partial message: retire the socket on cancellation.
        let mut socket = self.socket.take().ok_or_else(closed)?;
        socket.send(value, cancellation).await?;
        self.socket = Some(socket);
        Ok(())
    }

    /// Dropping this receive future preserves the connection for the next audio send.
    pub async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<LiveEvent, ApiError> {
        let result = self
            .socket
            .as_mut()
            .ok_or_else(closed)?
            .receive(cancellation)
            .await;
        let result = result.and_then(|value| decode(&value, &self.session_id));
        if result.is_err() || matches!(result, Ok(LiveEvent::Closed { .. })) {
            self.abort();
        }
        result
    }

    /// Waits for authoritative final usage; a transport close alone is not successful finalization.
    pub async fn close(&mut self, cancellation: &CancellationToken) -> Result<LiveEvent, ApiError> {
        let mut socket = self.socket.take().ok_or_else(closed)?;
        socket
            .send(json!({"type":"session.close"}), cancellation)
            .await?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let value = socket.receive(cancellation).await?;
                let event = decode(&value, &self.session_id)?;
                if matches!(event, LiveEvent::Closed { .. }) {
                    return Ok(event);
                }
                if matches!(event, LiveEvent::Error { .. }) {
                    return Err(ApiError::InvalidResponse("Live close was rejected".into()));
                }
            }
        })
        .await
        .map_err(|_| ApiError::Transport("Live finalization timed out".into()))?;
        socket.shutdown(cancellation).await?;
        result
    }
}

fn context(kind: &str, id: String, content: String) -> Result<Value, ApiError> {
    if id.is_empty() || content.is_empty() {
        return Err(ApiError::InvalidRequest(
            "Live delegation context is empty".into(),
        ));
    }
    Ok(json!({"type":kind,"delegation_id":id,"content":content}))
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::InvalidResponse(format!("Live event lacks {field}")))
}
fn number(value: &Value, field: &str) -> Result<u64, ApiError> {
    value[field]
        .as_u64()
        .ok_or_else(|| ApiError::InvalidResponse(format!("Live event lacks {field}")))
}
fn seconds(value: &Value) -> Result<f64, ApiError> {
    value["usage"]["seconds"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or_else(|| ApiError::InvalidResponse("invalid Live usage".into()))
}
fn closed() -> ApiError {
    ApiError::Transport("Live session is closed".into())
}
fn decode(value: &Value, id: &str) -> Result<LiveEvent, ApiError> {
    let kind = text(value, "type")?;
    match kind {
        "session.output_audio.delta" => {
            let pcm16 = STANDARD
                .decode(text(value, "delta")?)
                .map_err(|_| ApiError::InvalidResponse("invalid Live audio encoding".into()))?;
            if pcm16.is_empty() || pcm16.len() % 2 != 0 {
                return Err(ApiError::InvalidResponse(
                    "incomplete Live audio sample".into(),
                ));
            }
            Ok(LiveEvent::Audio { pcm16 })
        }
        "session.input_transcript.delta" | "session.output_transcript.delta" => {
            let text = text(value, "delta")?.to_owned();
            let start_ms = number(value, "start_ms")?;
            let end_ms = number(value, "end_ms")?;
            if end_ms < start_ms {
                return Err(ApiError::InvalidResponse(
                    "invalid Live transcript time range".into(),
                ));
            }
            if kind == "session.input_transcript.delta" {
                Ok(LiveEvent::InputTranscript {
                    text,
                    start_ms,
                    end_ms,
                })
            } else {
                Ok(LiveEvent::OutputTranscript {
                    text,
                    start_ms,
                    end_ms,
                })
            }
        }
        "session.delegation.created" => {
            if value["delegation"]["target"] != "client" {
                return Err(ApiError::InvalidResponse(
                    "unexpected Live delegation target".into(),
                ));
            }
            Ok(LiveEvent::Delegation {
                id: text(&value["delegation"], "id")?.into(),
                offset_ms: number(value, "offset_ms")?,
            })
        }
        "session.usage.updated" => Ok(LiveEvent::Usage {
            seconds: seconds(value)?,
        }),
        "session.closed" => {
            if text(&value["session"], "id")? != id {
                return Err(ApiError::InvalidResponse(
                    "Live session identity changed".into(),
                ));
            }
            Ok(LiveEvent::Closed {
                reason: text(value, "reason")?.into(),
                seconds: seconds(value)?,
            })
        }
        "error" => Ok(LiveEvent::Error {
            code: text(&value["error"], "code")?.into(),
        }),
        _ => Ok(LiveEvent::Other {
            event_type: kind.into(),
        }),
    }
}
