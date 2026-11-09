//! Subscription dictation stays bound to the account that admitted capture.

use crate::ChatGptOAuth;
use crate::credential::AccountIdentity;
use crate::oauth::ChatGptApiTarget;
use ash_http_client::HttpHeader;
use ash_websocket_client::WebSocketConnection;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketMessage;
use ash_websocket_client::WebSocketRequest;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://chatgpt.com/backend-api";
const STREAM_URL: &str =
    "wss://chatgpt.com/backend-api/dictation/stream?dictation_surface=composer&client_type=desktop";

/// Sanitized domain failures; clients translate these stable identifiers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatGptDictationError {
    AuthenticationRequired,
    AccessDenied,
    AccountChanged,
    RateLimited,
    RequestFailed,
    InvalidResponse,
}

impl fmt::Display for ChatGptDictationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationRequired => "CodexDictationAuthenticationRequired",
            Self::AccessDenied => "CodexDictationAccessDenied",
            Self::AccountChanged => "CodexDictationAccountChanged",
            Self::RateLimited => "CodexDictationRateLimited",
            Self::RequestFailed => "CodexDictationRequestFailed",
            Self::InvalidResponse => "CodexDictationInvalidResponse",
        })
    }
}

impl std::error::Error for ChatGptDictationError {}

/// One recording's subscription authority. Holds account identity, never a second token store.
pub struct ChatGptDictation {
    auth: Arc<ChatGptOAuth>,
    identity: AccountIdentity,
}

impl ChatGptDictation {
    pub fn new(auth: Arc<ChatGptOAuth>) -> Result<Self, ChatGptDictationError> {
        let target = auth
            .api_target_for(BASE_URL)
            .map_err(|_| ChatGptDictationError::AuthenticationRequired)?;
        Ok(Self {
            auth,
            identity: target.identity,
        })
    }

    pub fn check_account(&self) -> Result<(), ChatGptDictationError> {
        self.target().map(|_| ())
    }

    fn target(&self) -> Result<ChatGptApiTarget, ChatGptDictationError> {
        let target = self
            .auth
            .api_target_for(BASE_URL)
            .map_err(|_| ChatGptDictationError::AuthenticationRequired)?;
        if target.identity != self.identity {
            return Err(ChatGptDictationError::AccountChanged);
        }
        Ok(target)
    }

    /// Opens the same session for microphone frames and buffered PCM.
    /// The service selects its recognizer for the signed-in account.
    pub async fn connect(
        &self,
        connector: &WebSocketConnector,
        language: Option<&str>,
    ) -> Result<ChatGptDictationStream, ChatGptDictationError> {
        let target = self.target()?;
        let mut headers = target.api_target().headers().to_vec();
        headers.push(HttpHeader::new("Origin", "https://chatgpt.com"));
        headers.push(HttpHeader::new(
            "Sec-WebSocket-Protocol",
            "chatgpt-dictation, codex-desktop",
        ));
        let request = WebSocketRequest::new(STREAM_URL, headers)
            .map_err(|_| ChatGptDictationError::RequestFailed)?;
        tokio::time::timeout(Duration::from_secs(10), async {
            let (socket, _) = connector
                .connect(request)
                .await
                .map_err(|error| match error {
                    ash_websocket_client::WebSocketClientError::HandshakeRejected(401) => {
                        self.auth.note_rejected(&target);
                        ChatGptDictationError::AuthenticationRequired
                    }
                    ash_websocket_client::WebSocketClientError::HandshakeRejected(403) => {
                        ChatGptDictationError::AccessDenied
                    }
                    ash_websocket_client::WebSocketClientError::HandshakeRejected(429) => {
                        ChatGptDictationError::RateLimited
                    }
                    _ => ChatGptDictationError::RequestFailed,
                })?;
            let mut stream = ChatGptDictationStream {
                socket,
                utterances: Vec::new(),
            };
            stream.send(start_event(language)?).await?;
            loop {
                let event = stream.read().await?;
                match event {
                    WireEvent::Started => {
                        self.check_account()?;
                        return Ok(stream);
                    }
                    WireEvent::Updated { session } if session.status == "closed" => {
                        return Err(ChatGptDictationError::InvalidResponse);
                    }
                    _ => event.check_error()?,
                }
            }
        })
        .await
        .map_err(|_| ChatGptDictationError::RequestFailed)?
    }
}

fn request_id() -> Result<String, ChatGptDictationError> {
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| ChatGptDictationError::RequestFailed)?;
    random[6] = (random[6] & 0x0f) | 0x40;
    random[8] = (random[8] & 0x3f) | 0x80;
    let hex = format!("{:032x}", u128::from_be_bytes(random));
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn start_event(language: Option<&str>) -> Result<Value, ChatGptDictationError> {
    let mut config = json!({
        "input_audio_format": "pcm16",
        "sample_rate_hz": 24000,
        "num_channels": 1,
        "max_buffer_size_bytes": 4194304,
        "max_utterance_duration_ms": 30000,
        "session_ttl_ms": 300000,
        "provider_mode": "streaming_sse",
        "transcript_delivery_mode": "segment",
        "vad": { "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500 }
    });
    if let Some(language) = language {
        config["language"] = json!(language);
    }
    Ok(json!({
        "type": "session.start",
        "dictation_session_id": request_id()?,
        "attempt_id": request_id()?,
        "config": config
    }))
}

/// Current cumulative draft or the acknowledged final transcript of one recording.
pub enum ChatGptDictationEvent {
    Transcript(String),
    Finished(String),
    Other,
}

/// Provider session for mono 24 kHz PCM. Dropping it discards the recording.
pub struct ChatGptDictationStream {
    socket: WebSocketConnection,
    utterances: Vec<(String, Transcript)>,
}

impl ChatGptDictationStream {
    pub async fn append_pcm(&mut self, samples: &[i16]) -> Result<(), ChatGptDictationError> {
        if samples.is_empty() {
            return Ok(());
        }
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        self.send(json!({
            "type": "audio.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(bytes)
        }))
        .await
    }

    pub async fn finish_input(&mut self) -> Result<(), ChatGptDictationError> {
        self.send(json!({ "type": "session.close" })).await
    }

    pub async fn receive(&mut self) -> Result<ChatGptDictationEvent, ChatGptDictationError> {
        let event = self.read().await?;
        event.check_error()?;
        match event {
            WireEvent::Segment(transcript) => {
                store_transcript(&mut self.utterances, transcript, false);
            }
            WireEvent::Final(transcript) => {
                store_transcript(&mut self.utterances, transcript, true);
            }
            WireEvent::Updated { session } if session.status == "closed" => {
                return Ok(ChatGptDictationEvent::Finished(join_transcripts(
                    &self.utterances,
                    true,
                )));
            }
            _ => return Ok(ChatGptDictationEvent::Other),
        }
        Ok(ChatGptDictationEvent::Transcript(join_transcripts(
            &self.utterances,
            false,
        )))
    }

    async fn send(&mut self, event: Value) -> Result<(), ChatGptDictationError> {
        self.socket
            .send(WebSocketMessage::Text(event.to_string()))
            .await
            .map_err(|_| ChatGptDictationError::RequestFailed)
    }

    async fn read(&mut self) -> Result<WireEvent, ChatGptDictationError> {
        match self
            .socket
            .receive()
            .await
            .map_err(|_| ChatGptDictationError::RequestFailed)?
        {
            WebSocketMessage::Text(text) => {
                serde_json::from_str(&text).map_err(|_| ChatGptDictationError::InvalidResponse)
            }
            WebSocketMessage::Ping(_) | WebSocketMessage::Pong(_) => Ok(WireEvent::Other),
            _ => Err(ChatGptDictationError::InvalidResponse),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum WireEvent {
    #[serde(rename = "session.started")]
    Started,
    #[serde(rename = "session.updated")]
    Updated { session: SessionStatus },
    #[serde(rename = "transcript.segment")]
    Segment(WireTranscript),
    #[serde(rename = "transcript.final")]
    Final(WireTranscript),
    #[serde(rename = "transcript.failed")]
    TranscriptFailed,
    #[serde(rename = "session.error")]
    SessionError { fatal: bool },
    #[serde(other)]
    Other,
}

impl WireEvent {
    fn check_error(&self) -> Result<(), ChatGptDictationError> {
        match self {
            Self::TranscriptFailed | Self::SessionError { fatal: true } => {
                Err(ChatGptDictationError::RequestFailed)
            }
            _ => Ok(()),
        }
    }
}

#[derive(Deserialize)]
struct SessionStatus {
    status: String,
}

#[derive(Deserialize)]
struct WireTranscript {
    utterance_id: String,
    revision: u64,
    text: String,
}

struct Transcript {
    revision: u64,
    text: String,
    is_final: bool,
}

fn store_transcript(
    utterances: &mut Vec<(String, Transcript)>,
    next: WireTranscript,
    is_final: bool,
) {
    let transcript = Transcript {
        revision: next.revision,
        text: next.text,
        is_final,
    };
    if let Some((_, current)) = utterances
        .iter_mut()
        .find(|(id, _)| id == &next.utterance_id)
    {
        if (is_final && !current.is_final)
            || (is_final == current.is_final && next.revision >= current.revision)
        {
            *current = transcript;
        }
    } else {
        utterances.push((next.utterance_id, transcript));
    }
}

fn join_transcripts(utterances: &[(String, Transcript)], final_only: bool) -> String {
    utterances
        .iter()
        .filter(|(_, transcript)| !final_only || transcript.is_final)
        .map(|(_, transcript)| transcript.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
