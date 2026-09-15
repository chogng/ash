use serde::Deserialize;
use serde::Serialize;
use std::io;
#[cfg(any(test, feature = "host"))]
use std::io::Read;
#[cfg(feature = "host")]
use std::io::Write;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_BYTES: usize = 16 * 1024;

/// Mono PCM16 rates accepted by local audio sessions; each packet spans 20 milliseconds.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum SampleRate {
    #[serde(rename = "16000")]
    Hz16000,
    #[serde(rename = "24000")]
    Hz24000,
    #[serde(rename = "48000")]
    Hz48000,
}

impl SampleRate {
    pub const fn hz(self) -> u32 {
        match self {
            Self::Hz16000 => 16_000,
            Self::Hz24000 => 24_000,
            Self::Hz48000 => 48_000,
        }
    }
    pub const fn packet_samples(self) -> usize {
        self.hz() as usize / 50
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Capture,
    Playback,
    Duplex,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Processing {
    Unprocessed,
    Speech,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Recording,
    Muted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioConfig {
    pub rate: SampleRate,
    pub direction: Direction,
    pub processing: Processing,
}

/// Epochs invalidate queued capture on mute/stop. Sequence gaps indicate dropped live packets.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub epoch: u64,
    pub sequence: u64,
    pub samples: Vec<i16>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Operation {
    Hello { version: u32 },
    Start { config: AudioConfig },
    Capture { state: CaptureState },
    Play { epoch: u64, samples: Vec<i16> },
    Interrupt,
    Stop,
    Shutdown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub id: u64,
    #[serde(rename = "command")]
    pub operation: Operation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Event {
    Reply {
        id: u64,
        epoch: u64,
        error: Option<String>,
    },
    Capture {
        audio: Capture,
    },
    Failed,
}

pub(crate) fn encode(value: &impl Serialize) -> io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let mut result = Vec::with_capacity(bytes.len() + 4);
    result.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    result.extend_from_slice(&bytes);
    Ok(result)
}

#[cfg(any(test, feature = "host"))]
pub(crate) fn read<T: serde::de::DeserializeOwned>(
    reader: &mut impl Read,
) -> io::Result<Option<T>> {
    let mut length = [0; 4];
    if reader.read(&mut length[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length[1..])?;
    let len = u32::from_le_bytes(length) as usize;
    if len == 0 || len > MAX_BYTES {
        return Err(invalid());
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| invalid())
}

#[cfg(feature = "host")]
pub(crate) fn write(writer: &mut impl Write, event: &Event) -> io::Result<()> {
    writer.write_all(&encode(event)?)?;
    writer.flush()
}

pub(crate) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid audio frame")
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
