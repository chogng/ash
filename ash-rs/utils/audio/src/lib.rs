//! Bounded audio container validation and duration measurement for model attachments.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use std::io::Cursor;
use std::sync::Arc;
use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::TrackType;
use symphonia::core::formats::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use thiserror::Error;

pub const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_AUDIO_DURATION_MS: u64 = 60 * 60 * 1000;
const MAX_AUDIO_PACKETS: usize = 1_000_000;

/// Container formats accepted at the audio attachment boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioFormat {
    Wav,
    Mp3,
    M4a,
    WebM,
    Ogg,
}

impl AudioFormat {
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mp3 => "audio/mpeg",
            Self::M4a => "audio/mp4",
            Self::WebM => "audio/webm",
            Self::Ogg => "audio/ogg",
        }
    }

    pub fn from_mime_type(mime: &str) -> Option<Self> {
        match mime.to_ascii_lowercase().as_str() {
            "audio/wav" | "audio/wave" | "audio/x-wav" => Some(Self::Wav),
            "audio/mpeg" | "audio/mp3" => Some(Self::Mp3),
            "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some(Self::M4a),
            "audio/webm" => Some(Self::WebM),
            "audio/ogg" => Some(Self::Ogg),
            _ => None,
        }
    }
}

/// Validated, unchanged encoded audio with duration measured from its container packets.
#[derive(Clone, Debug)]
pub struct EncodedAudio {
    bytes: Arc<[u8]>,
    format: AudioFormat,
    duration_ms: u64,
}

impl EncodedAudio {
    pub fn bytes(&self) -> &Arc<[u8]> {
        &self.bytes
    }
    pub fn format(&self) -> AudioFormat {
        self.format
    }
    pub fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    pub fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.format.mime_type(),
            STANDARD.encode(&self.bytes)
        )
    }
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("audio must contain between 1 and {MAX_AUDIO_BYTES} encoded bytes")]
    Size,
    #[error("audio must use a supported base64 data URL")]
    DataUrl,
    #[error("audio container does not match its declared media type")]
    Format,
    #[error("audio must contain one audio track with a bounded, measurable duration")]
    Duration,
    #[error("invalid audio container: {0}")]
    Container(String),
}

/// Estimates duration-based prompt cost at ten tokens per second, rounded upward.
/// This is a planning estimate; provider billing and exact counts have separate owners.
pub const fn approximate_tokens(duration_ms: u64) -> u64 {
    duration_ms.div_ceil(100)
}

pub fn load_data_url(url: &str) -> Result<EncodedAudio, AudioError> {
    let (metadata, payload) = url.split_once(',').ok_or(AudioError::DataUrl)?;
    let metadata = metadata.strip_prefix("data:").ok_or(AudioError::DataUrl)?;
    let mime = metadata
        .strip_suffix(";base64")
        .ok_or(AudioError::DataUrl)?;
    let format = AudioFormat::from_mime_type(mime).ok_or(AudioError::Format)?;
    if payload.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
        return Err(AudioError::Size);
    }
    let bytes = STANDARD.decode(payload).map_err(|_| AudioError::DataUrl)?;
    load_bytes(bytes.into(), format)
}

pub fn load_bytes(bytes: Arc<[u8]>, format: AudioFormat) -> Result<EncodedAudio, AudioError> {
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES {
        return Err(AudioError::Size);
    }
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes.clone())), Default::default());
    let mut hint = Hint::new();
    hint.mime_type(format.mime_type());
    let mut reader = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| AudioError::Container(error.to_string()))?;
    let expected = match format {
        AudioFormat::Wav => "wave",
        AudioFormat::Mp3 => "mp3",
        AudioFormat::M4a => "isomp4",
        AudioFormat::WebM => "matroska",
        AudioFormat::Ogg => "ogg",
    };
    if reader.format_info().short_name != expected {
        return Err(AudioError::Format);
    }
    if reader.tracks().len() != 1 {
        return Err(AudioError::Duration);
    }
    let track = reader
        .default_track(TrackType::Audio)
        .ok_or(AudioError::Duration)?;
    let track_id = track.id;
    let time_base = track.time_base.ok_or(AudioError::Duration)?;
    let start = i128::from(track.start_ts.get());
    let mut end = start;
    let mut packets = 0usize;
    while let Some(packet) = reader
        .next_packet()
        .map_err(|error| AudioError::Container(error.to_string()))?
    {
        packets += 1;
        if packets > MAX_AUDIO_PACKETS || packet.track_id != track_id {
            return Err(AudioError::Duration);
        }
        end = end.max(i128::from(packet.pts.get()) + i128::from(packet.dur.get()));
        let millis = u128::try_from(end - start).map_err(|_| AudioError::Duration)?
            * u128::from(time_base.numer.get())
            * 1000;
        if millis > u128::from(MAX_AUDIO_DURATION_MS) * u128::from(time_base.denom.get()) {
            return Err(AudioError::Duration);
        }
    }
    let duration_ms = (u128::try_from(end - start).map_err(|_| AudioError::Duration)?
        * u128::from(time_base.numer.get())
        * 1000)
        .div_ceil(u128::from(time_base.denom.get()));
    let duration_ms = u64::try_from(duration_ms).map_err(|_| AudioError::Duration)?;
    if packets == 0 || duration_ms == 0 {
        return Err(AudioError::Duration);
    }
    Ok(EncodedAudio {
        bytes,
        format,
        duration_ms,
    })
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
