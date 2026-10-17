//! Closed, versioned data channel shared only by the provider and its domain adapters.

use crate::AudioPublication;
use crate::MediaEvent;
use crate::MediaStats;
use serde::Deserialize;
use serde::Serialize;

pub const EXTENSION_ID: &str = "ash.livekit";
pub const CHANNEL_ID: &str = "livekit.v1";
pub const MAX_PAYLOAD_BYTES: usize = 48 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = MAX_PAYLOAD_BYTES + 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "id", rename_all = "camelCase")]
pub enum ScreenTarget {
    Display(String),
    Window(String),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenSource {
    pub target: ScreenTarget,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Connect {
        server_url: String,
        token: String,
        publication: AudioPublication,
    },
    SendAudio {
        samples: Vec<i16>,
    },
    Mute {
        muted: bool,
    },
    Poll,
    Stats,
    ShareScreen {
        target: ScreenTarget,
        fps: u32,
    },
    StopScreen,
    Close,
    ScreenSources,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Response {
    Done,
    Event(Option<MediaEvent>),
    Stats(MediaStats),
    ScreenSources(Vec<ScreenSource>),
}
