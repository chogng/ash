//! Private contract between the App Server and its native Computer Use provider.

use serde::Deserialize;
use serde::Serialize;

pub const CHANNEL: &str = "computer-use.windows.v1";
pub const EXTENSION_ID: &str = "ash.computer-use";
pub const BINARY: &str = "ash-computer-use.exe";
pub const MAX_WINDOWS: usize = 12;
pub const MAX_VALUE_BYTES: usize = 8192;

/// Kept on the host side. The model only receives elements from the granted window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub handle: u64,
    pub process: u32,
    pub process_started: u64,
    pub title: String,
    pub app: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    ListWindows {
        query: Option<String>,
    },
    Bind {
        window: Window,
    },
    Observe {
        observation: u32,
        screenshot: bool,
    },
    Act {
        observation: u32,
        element: u32,
        action: Action,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Invoke,
    Select,
    ScrollIntoView,
    SetValue { value: String },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Windows {
        windows: Vec<Window>,
    },
    Bound,
    Observation {
        observation: u32,
        elements: Vec<Element>,
        truncated: bool,
        screenshot_png: Option<String>,
    },
    Applied,
    Failed {
        message: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Element {
    pub id: u32,
    pub depth: u8,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub enabled: bool,
    pub actions: Vec<ElementAction>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementAction {
    Invoke,
    Select,
    ScrollIntoView,
    SetValue,
}
