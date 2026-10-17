//! Local recognition protocol and client; inference remains in the packaged helper.
use ash_external_ext::ExtensionHostSupervisor;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

pub const EXTENSION_ID: &str = "ash.recognition";
pub const MAX_PAYLOAD_BYTES: usize = 48 * 1024 * 1024;
pub const CHANNEL_ID: &str = "recognition.v1";
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecognitionMode {
    Dictation,
    Conversation,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "samples", rename_all = "camelCase")]
pub enum RecognitionInput {
    Audio(Vec<i16>),
    Finish,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    OpenRecognizer {
        encoder: PathBuf,
        decoder: PathBuf,
        tokens: PathBuf,
        mode: RecognitionMode,
    },
    Recognize {
        input: RecognitionInput,
    },
    ResetRecognizer,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Response {
    Done,
    Recognition { text: String, endpoint: bool },
}
pub struct Recognition {
    pub text: String,
    pub endpoint: bool,
}
pub struct Recognizer(ExtensionHostSupervisor);
impl Recognizer {
    pub fn open(
        executable: &Path,
        encoder: &Path,
        decoder: &Path,
        tokens: &Path,
        mode: RecognitionMode,
    ) -> Result<Self, String> {
        if [encoder, decoder, tokens]
            .iter()
            .any(|path| !path.is_absolute() || !path.is_file())
        {
            return Err("invalid media capability response".into());
        }
        let worker = ExtensionHostSupervisor::start_product_resource(
            executable,
            EXTENSION_ID,
            MAX_PAYLOAD_BYTES,
        )
        .map_err(|error| error.to_string())?;
        let recognizer = Self(worker);
        match recognizer.request(Request::OpenRecognizer {
            encoder: encoder.into(),
            decoder: decoder.into(),
            tokens: tokens.into(),
            mode,
        })? {
            Response::Done => Ok(recognizer),
            Response::Recognition { .. } => Err("invalid media capability response".into()),
        }
    }
    fn request(&self, request: Request) -> Result<Response, String> {
        let handle = self
            .0
            .begin_data_channel(
                CHANNEL_ID,
                serde_json::to_value(request).map_err(|error| error.to_string())?,
                Duration::from_secs(30),
            )
            .map_err(|error| error.to_string())?;
        let response = handle.wait().map_err(|error| error.to_string())?;
        serde_json::from_value::<Result<Response, String>>(response.payload)
            .map_err(|error| error.to_string())?
    }
    pub fn accept_audio(&self, samples: &[i16]) -> Result<Recognition, String> {
        self.recognize(RecognitionInput::Audio(samples.into()))
    }
    pub fn finish(&self) -> Result<Recognition, String> {
        self.recognize(RecognitionInput::Finish)
    }
    fn recognize(&self, input: RecognitionInput) -> Result<Recognition, String> {
        match self.request(Request::Recognize { input })? {
            Response::Recognition { text, endpoint } => Ok(Recognition { text, endpoint }),
            Response::Done => Err("invalid media capability response".into()),
        }
    }
    pub fn reset(&self) -> Result<(), String> {
        match self.request(Request::ResetRecognizer)? {
            Response::Done => Ok(()),
            Response::Recognition { .. } => Err("invalid media capability response".into()),
        }
    }
}
impl Drop for Recognizer {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}

/// Resolve only when loading inference, after model validation and background cancellation.
pub(crate) fn executable(
    home: &Path,
    network: &http_client::OutboundNetworkSnapshot,
) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ASH_RECOGNIZER_PATH") {
        let path = PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err("optional media runtime is not installed or available".into());
        }
        return path.canonicalize().map_err(|error| error.to_string());
    }
    let offline = std::env::var_os("ASH_MEDIA_PACKAGE").map(PathBuf::from);
    let source = match offline.as_deref() {
        Some(path) => ash_package_store::CapabilitySource::Directory(path),
        None => ash_package_store::CapabilitySource::ProductBound,
    };
    ash_package_store::resolve_capability_executable(
        home,
        "media",
        "ash-realtime-voice",
        source,
        &http_client::ReqwestHttpClient::with_network(network.clone())
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
