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

/// One live hypothesis or the committed result of a microphone turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TranscriptionEvent {
    Delta { item_id: String, text: String },
    Completed { item_id: String, text: String },
    Error { message: String },
    Other,
}

/// A dedicated Realtime transcription session with caller-owned microphone capture.
pub struct TranscriptionSession {
    socket: JsonSocket,
    session_id: String,
}

impl TranscriptionSession {
    pub async fn connect(
        connector: &WebSocketConnector,
        target: &ResolvedApiTarget,
        model: &str,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<Self, ApiError> {
        if model != "gpt-live-transcribe" {
            return Err(ApiError::InvalidRequest(
                "Unsupported live transcription model".into(),
            ));
        }
        let mut url = crate::websocket::url(&target.base_url, "realtime")?;
        url.query_pairs_mut().append_pair("model", model);
        let request = WebSocketRequest::new(url.as_str(), target.headers.clone())
            .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
        let (mut socket, _) = JsonSocket::connect(connector, request, limits, cancellation).await?;
        let created = socket.receive(cancellation).await?;
        if created["type"] != "session.created" {
            return Err(ApiError::InvalidResponse(
                "Transcription session.created was not received".into(),
            ));
        }
        let session_id = created["session"]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ApiError::InvalidResponse("Transcription session has no ID".into()))?
            .to_owned();
        socket
            .send(
                json!({
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": { "input": {
                            "format": { "type": "audio/pcm", "rate": 24000 },
                            "transcription": { "model": model },
                            "turn_detection": null
                        }}
                    }
                }),
                cancellation,
            )
            .await?;
        let updated = socket.receive(cancellation).await?;
        if updated["type"] != "session.updated"
            || updated["session"]["id"] != session_id
            || updated["session"]["type"] != "transcription"
        {
            return Err(ApiError::InvalidResponse(
                "Transcription session update was rejected".into(),
            ));
        }
        Ok(Self { socket, session_id })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn append_audio(
        &mut self,
        pcm16: &[u8],
        cancellation: &CancellationToken,
    ) -> Result<(), ApiError> {
        if pcm16.is_empty() || pcm16.len() % 2 != 0 {
            return Err(ApiError::InvalidRequest(
                "PCM16 audio must contain complete samples".into(),
            ));
        }
        self.socket
            .send(
                json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(pcm16)}),
                cancellation,
            )
            .await
    }

    pub async fn commit(&mut self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.socket
            .send(json!({"type":"input_audio_buffer.commit"}), cancellation)
            .await
    }

    pub async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<TranscriptionEvent, ApiError> {
        let value = self.socket.receive(cancellation).await?;
        Self::decode_event(&value)
    }

    pub async fn close(self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.socket.shutdown(cancellation).await
    }

    fn decode_event(value: &Value) -> Result<TranscriptionEvent, ApiError> {
        let event = match value["type"].as_str() {
            Some("conversation.item.input_audio_transcription.delta") => {
                TranscriptionEvent::Delta {
                    item_id: field(value, "item_id")?.into(),
                    text: field(value, "delta")?.into(),
                }
            }
            Some("conversation.item.input_audio_transcription.completed") => {
                TranscriptionEvent::Completed {
                    item_id: field(value, "item_id")?.into(),
                    text: field(value, "transcript")?.into(),
                }
            }
            Some("error") => TranscriptionEvent::Error {
                message: value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Transcription failed")
                    .into(),
            },
            Some(_) => TranscriptionEvent::Other,
            None => {
                return Err(ApiError::InvalidResponse(
                    "Transcription event has no type".into(),
                ));
            }
        };
        Ok(event)
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    value[name]
        .as_str()
        .ok_or_else(|| ApiError::InvalidResponse(format!("Transcription event is missing {name}")))
}

#[cfg(test)]
#[path = "transcription_tests.rs"]
mod tests;
