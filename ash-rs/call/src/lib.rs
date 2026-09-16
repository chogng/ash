//! Durable call membership and media generations, independent of UI and media SDKs.

mod store;

use ash_secrets::SecretValue;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
pub use store::CallStore;

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("invalid call input")]
    Invalid,
    #[error("call access denied")]
    Denied,
    #[error("call revision or operation conflicts")]
    Conflict,
    #[error("call media is not ready")]
    NotReady,
    #[error("call storage failed")]
    Storage,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallRole {
    Owner,
    Speaker,
    Listener,
    Agent,
}

impl CallRole {
    pub fn can_publish_audio(self) -> bool {
        self != Self::Listener
    }
    pub fn can_share_screen(self) -> bool {
        matches!(self, Self::Owner | Self::Speaker)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum MediaState {
    Preparing,
    Ready,
    Rotating { previous_room: String },
    Closing,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMember {
    pub id: String,
    pub role: CallRole,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSnapshot {
    pub id: String,
    pub revision: u64,
    pub media_epoch: u64,
    pub media_room: String,
    pub media_state: MediaState,
    pub members: Vec<CallMember>,
}

/// Room authority credential. Only its SHA-256 digest is persisted.
/// Callers retain their generated credential across idempotent retries.
pub struct MemberCredential(SecretValue);

impl MemberCredential {
    pub fn generate() -> Self {
        Self(SecretValue::new(identifier().into_bytes()))
    }
    pub fn parse(value: String) -> Result<Self, CallError> {
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CallError::Invalid);
        }
        Ok(Self(SecretValue::new(value.into_bytes())))
    }
    pub fn expose(&self) -> &str {
        std::str::from_utf8(self.0.expose()).expect("validated hexadecimal credential")
    }
    pub(crate) fn digest(&self) -> String {
        digest(self.0.expose())
    }
}

#[derive(Clone, Debug)]
pub struct JoinGrant {
    pub call: CallSnapshot,
    pub member: CallMember,
    pub participant_id: String,
    pub microphone: bool,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn identifier() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_id(value: &str) -> Result<(), CallError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(CallError::Invalid);
    }
    Ok(())
}
