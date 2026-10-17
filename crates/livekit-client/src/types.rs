use serde::Deserialize;
use serde::Serialize;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum AudioPublication {
    Microphone,
    Agent,
    SubscribeOnly,
}

/// Decoded mono PCM at 48 kHz, with its authenticated transport source preserved.
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioFrame {
    pub participant_id: String,
    pub track_id: String,
    #[serde(with = "instant")]
    pub received_at: Instant,
    pub samples: Vec<i16>,
}

/// Decoded RGBA video, independently bounded from audio and control events.
#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenFrame {
    pub participant_id: String,
    pub track_id: String,
    #[serde(with = "instant")]
    pub received_at: Instant,
    pub width: u32,
    pub height: u32,
    pub rotation: u16,
    #[serde(with = "bytes")]
    pub rgba: Vec<u8>,
}

/// Counts the connection reports returned for the room's publishing and subscribing paths.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaStats {
    pub publisher_reports: usize,
    pub subscriber_reports: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum MediaEvent {
    Connected {
        participant_ids: Vec<String>,
    },
    Audio(AudioFrame),
    Video(ScreenFrame),
    ScreenAdded {
        participant_id: String,
        track_id: String,
    },
    ScreenStopped {
        error: Option<String>,
    },
    ParticipantJoined {
        participant_id: String,
    },
    ParticipantLeft {
        participant_id: String,
    },
    TrackAdded {
        participant_id: String,
        track_id: String,
    },
    TrackRemoved {
        track_id: String,
    },
    TrackMuted {
        track_id: String,
    },
    TrackUnmuted {
        track_id: String,
    },
    Reconnecting,
    Reconnected,
    Disconnected,
}

#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
pub enum MediaError {
    #[error("optional media runtime is not installed or available")]
    Unavailable,
    #[error("invalid media capability response")]
    Protocol,
    #[error("invalid media server address")]
    Address,
    #[error("media connection failed")]
    Connection,
    #[error("media operation timed out")]
    Timeout,
    #[error("audio publication is unavailable")]
    Publication,
    #[error("audio frame must contain 480 or 960 mono samples at 48 kHz")]
    AudioFrame,
    #[error("media event consumer is closed or overloaded")]
    Consumer,
    #[error("screen share publication failed")]
    ScreenShare,
    #[error("screen capture failed: {0}")]
    Capture(String),
}

mod instant {
    use serde::Deserialize;
    use serde::Deserializer;
    use serde::Serializer;
    use std::time::Duration;
    use std::time::Instant;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;
    pub fn serialize<S: Serializer>(instant: &Instant, serializer: S) -> Result<S::Ok, S::Error> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(serde::ser::Error::custom)?;
        serializer.serialize_u64(now.saturating_sub(instant.elapsed()).as_millis() as u64)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Instant, D::Error> {
        let timestamp = u64::deserialize(deserializer)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(serde::de::Error::custom)?;
        let age = now.saturating_sub(Duration::from_millis(timestamp));
        Instant::now()
            .checked_sub(age)
            .ok_or_else(|| serde::de::Error::custom("invalid media timestamp"))
    }
}
mod bytes {
    use base64::Engine;
    use serde::Deserialize;
    use serde::Deserializer;
    use serde::Serializer;
    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        base64::engine::general_purpose::STANDARD
            .decode(String::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}
