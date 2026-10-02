use crate::ApiError;
use crate::WebSocketSessionConfig;
use crate::websocket::JsonSocket;
use ash_async_utils::CancellationToken;
use ash_client::ResolvedApiTarget;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketRequest;
use serde_json::Value;
use serde_json::json;

/// xAI's phrase boundaries are distinct from completion of the capture session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum XaiTranscriptionEvent {
    Partial {
        text: String,
        is_final: bool,
        speech_final: bool,
    },
    Done {
        text: String,
    },
    Error {
        message: String,
    },
    Other,
}

pub struct XaiTranscriptionSession {
    socket: JsonSocket,
}

impl XaiTranscriptionSession {
    pub async fn connect(
        connector: &WebSocketConnector,
        target: &ResolvedApiTarget,
        model: &str,
        limits: WebSocketSessionConfig,
        language: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Self, ApiError> {
        if model != "grok-voice-transcribe-2.0" {
            return Err(ApiError::InvalidRequest(
                "Unsupported xAI transcription model".into(),
            ));
        }
        let mut url = crate::websocket::bound_url(target, "stt")?;
        url.query_pairs_mut().extend_pairs([
            ("model", model),
            ("sample_rate", "16000"),
            ("encoding", "pcm"),
            ("interim_results", "true"),
        ]);
        if let Some(language) = language {
            url.query_pairs_mut().append_pair("language", language);
        }
        let request = WebSocketRequest::new(
            url.as_str(),
            ash_client::merge_headers(target.headers().to_vec(), Vec::new())?,
        )
        .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;
        let (mut socket, _) = JsonSocket::connect(connector, request, limits, cancellation).await?;
        let created = socket.receive(cancellation).await?;
        if created["type"] != "transcript.created" {
            return Err(ApiError::InvalidResponse(
                "xAI transcript.created was not received".into(),
            ));
        }
        Ok(Self { socket })
    }

    pub async fn append_audio(
        &mut self,
        pcm16: &[u8],
        cancellation: &CancellationToken,
    ) -> Result<(), ApiError> {
        if pcm16.len() % 2 != 0 {
            return Err(ApiError::InvalidRequest(
                "PCM16 audio must contain complete samples".into(),
            ));
        }
        self.socket.send_binary(pcm16, cancellation).await
    }

    pub async fn finish(&mut self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.socket
            .send(json!({"type":"audio.done"}), cancellation)
            .await
    }

    pub async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<XaiTranscriptionEvent, ApiError> {
        let value = self.socket.receive(cancellation).await?;
        Self::decode_event(&value)
    }

    pub async fn close(self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        self.socket.shutdown(cancellation).await
    }

    fn decode_event(value: &Value) -> Result<XaiTranscriptionEvent, ApiError> {
        Ok(match value["type"].as_str() {
            Some("transcript.partial") => XaiTranscriptionEvent::Partial {
                text: field(value, "text")?.into(),
                is_final: field_bool(value, "is_final")?,
                speech_final: field_bool(value, "speech_final")?,
            },
            Some("transcript.done") => XaiTranscriptionEvent::Done {
                text: field(value, "text")?.into(),
            },
            Some("error") => XaiTranscriptionEvent::Error {
                message: field(value, "message")?.into(),
            },
            Some(_) => XaiTranscriptionEvent::Other,
            None => {
                return Err(ApiError::InvalidResponse(
                    "xAI transcription event has no type".into(),
                ));
            }
        })
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    value[name].as_str().ok_or_else(|| {
        ApiError::InvalidResponse(format!("xAI transcription event is missing {name}"))
    })
}

fn field_bool(value: &Value, name: &str) -> Result<bool, ApiError> {
    value[name].as_bool().ok_or_else(|| {
        ApiError::InvalidResponse(format!("xAI transcription event is missing {name}"))
    })
}

#[cfg(test)]
#[path = "xai_transcription_tests.rs"]
mod tests;
