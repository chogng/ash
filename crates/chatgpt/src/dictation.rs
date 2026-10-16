//! Subscription dictation stays bound to the account that admitted capture.

use crate::ChatGptOAuth;
use crate::credential::AccountIdentity;
use ash_async_utils::CancellationToken;
use ash_client::ClientRequest;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use std::fmt;
use std::sync::Arc;

const BASE_URL: &str = "https://chatgpt.com/backend-api";
const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;

/// Sanitized domain failures; clients translate these stable identifiers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatGptDictationError {
    AuthenticationRequired,
    AccessDenied,
    AccountChanged,
    InvalidAudio,
    AudioTooLong,
    RateLimited,
    RequestFailed,
    InvalidResponse,
    Cancelled,
}

impl fmt::Display for ChatGptDictationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationRequired => "CodexDictationAuthenticationRequired",
            Self::AccessDenied => "CodexDictationAccessDenied",
            Self::AccountChanged => "CodexDictationAccountChanged",
            Self::InvalidAudio => "CodexDictationInvalidAudio",
            Self::AudioTooLong => "CodexDictationAudioTooLong",
            Self::RateLimited => "CodexDictationRateLimited",
            Self::RequestFailed => "CodexDictationRequestFailed",
            Self::InvalidResponse => "CodexDictationInvalidResponse",
            Self::Cancelled => "CodexDictationCancelled",
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

    /// Uploads a bounded WAV once. Never replays recorded speech after an uncertain result.
    pub fn transcribe(
        &self,
        audio: &[u8],
        language: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<String, ChatGptDictationError> {
        check_cancelled(cancellation)?;
        if audio.len() > MAX_AUDIO_BYTES {
            return Err(ChatGptDictationError::AudioTooLong);
        }
        if audio.len() < 44 || !audio.starts_with(b"RIFF") || audio.get(8..12) != Some(b"WAVE") {
            return Err(ChatGptDictationError::InvalidAudio);
        }
        if language.is_some_and(|language| {
            language.is_empty()
                || language.len() > 32
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        }) {
            return Err(ChatGptDictationError::InvalidAudio);
        }
        let target = self
            .auth
            .api_target_for(BASE_URL)
            .map_err(|_| ChatGptDictationError::AuthenticationRequired)?;
        if target.identity != self.identity {
            return Err(ChatGptDictationError::AccountChanged);
        }
        check_cancelled(cancellation)?;
        // The boundary is fixed metadata, never derived from a filename or caller input.
        const BOUNDARY: &str = "ash-codex-dictation-audio";
        let mut body = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n").into_bytes();
        body.extend_from_slice(audio);
        if let Some(language) = language {
            body.extend_from_slice(format!("\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{language}").as_bytes());
        }
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        let mut headers = target.api_target().headers().to_vec();
        headers.push(HttpHeader::new(
            "Content-Type",
            format!("multipart/form-data; boundary={BOUNDARY}"),
        ));
        let request = ClientRequest::post(
            format!("{BASE_URL}/transcribe"),
            headers,
            body,
            RetryPolicy::never(),
        )
        .map_err(|_| ChatGptDictationError::RequestFailed)?
        .without_redirects();
        let response = self
            .auth
            .client
            .execute_with_cancellation(&request, cancellation);
        check_cancelled(cancellation)?;
        let current = self
            .auth
            .api_target_for(BASE_URL)
            .map_err(|_| ChatGptDictationError::AuthenticationRequired)?;
        if current.identity != self.identity {
            return Err(ChatGptDictationError::AccountChanged);
        }
        let response = response.map_err(|_| ChatGptDictationError::RequestFailed)?;
        match response.status() {
            401 => {
                self.auth.note_rejected(&target);
                return Err(ChatGptDictationError::AuthenticationRequired);
            }
            403 => return Err(ChatGptDictationError::AccessDenied),
            429 => return Err(ChatGptDictationError::RateLimited),
            _ if !response.is_success() => return Err(ChatGptDictationError::RequestFailed),
            _ => {}
        }
        if response.body().len() > 256 * 1024 {
            return Err(ChatGptDictationError::InvalidResponse);
        }
        let value: serde_json::Value = serde_json::from_slice(response.body())
            .map_err(|_| ChatGptDictationError::InvalidResponse)?;
        value["text"]
            .as_str()
            .map(str::to_owned)
            .ok_or(ChatGptDictationError::InvalidResponse)
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ChatGptDictationError> {
    if cancellation.is_cancelled() {
        Err(ChatGptDictationError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
