//! The TUI keeps microphone capture on the user's machine, even for a remote App Server.

use realtime_voice::LocalDictationRequest;
use realtime_voice::LocalSpeechEvent;
use realtime_voice::LocalSpeechMode;
use realtime_voice::LocalSpeechSession;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;

pub(crate) enum Event {
    Speech(LocalSpeechEvent),
    Stopped(Result<(), String>),
}

pub(crate) struct VoiceRuntime {
    session: Option<LocalSpeechSession>,
    stopping: bool,
    sender: mpsc::SyncSender<Event>,
    events: mpsc::Receiver<Event>,
    model_root: PathBuf,
}

impl VoiceRuntime {
    pub(crate) fn new(profile_root: &Path) -> Self {
        let (sender, events) = mpsc::sync_channel(64);
        Self {
            session: None,
            stopping: false,
            sender,
            events,
            model_root: profile_root.join("dictation-models"),
        }
    }

    pub(crate) fn start(&mut self) -> Result<(), String> {
        if self.session.is_some() || self.stopping {
            return Err("A speech session is already active".into());
        }
        let audio_host = executable()?;
        let network = ash_http_client::OutboundNetworkSnapshot::new(
            ash_http_client::HttpClientConfig::new()
                .with_redirect_policy(ash_http_client::RedirectPolicy::Follow {
                    max_hops: std::num::NonZeroU8::new(4).expect("nonzero redirect limit"),
                })
                .with_streaming_response_body_limit(
                    ash_http_client::ResponseBodyLimit::new(
                        std::num::NonZeroUsize::new(300 * 1024 * 1024)
                            .expect("nonzero model limit"),
                    )
                    .map_err(|error| error.to_string())?,
                )
                .with_timeouts(ash_http_client::TransportTimeouts::new(
                    ash_http_client::Timeout::After(std::time::Duration::from_secs(30)),
                    ash_http_client::Timeout::Disabled,
                    ash_http_client::Timeout::Disabled,
                    ash_http_client::Timeout::After(std::time::Duration::from_secs(300)),
                )),
        )
        .map_err(|error| error.to_string())?;
        let request = LocalDictationRequest {
            input_device: None,
            model_id: realtime_voice::DEFAULT_MODEL_ID.into(),
            model_root: self.model_root.clone(),
            audio_host,
            network,
        };
        let sender = self.sender.clone();
        self.session = Some(LocalSpeechSession::start(
            request,
            LocalSpeechMode::Conversation,
            move |event| {
                if matches!(event, LocalSpeechEvent::Partial { .. }) {
                    let _ = sender.try_send(Event::Speech(event));
                } else {
                    let _ = sender.send(Event::Speech(event));
                }
            },
        )?);
        Ok(())
    }

    pub(crate) fn stop(&mut self) -> Result<(), String> {
        let mut session = self.session.take().ok_or("No active voice session")?;
        self.stopping = true;
        let sender = self.sender.clone();
        let result = std::thread::Builder::new()
            .name("ash-tui-stop-voice".into())
            .spawn(move || {
                let _ = sender.send(Event::Stopped(session.stop()));
            });
        if let Err(error) = result {
            self.stopping = false;
            return Err(error.to_string());
        }
        Ok(())
    }

    pub(crate) fn poll(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            match &event {
                Event::Speech(LocalSpeechEvent::Ended { .. }) => {
                    if let Some(mut session) = self.session.take() {
                        let _ = session.stop();
                    }
                }
                Event::Stopped(_) => self.stopping = false,
                _ => {}
            }
            events.push(event);
        }
        events
    }
}

impl Drop for VoiceRuntime {
    fn drop(&mut self) {
        // Closing the receiver releases a worker waiting to deliver a final utterance.
        let (_, replacement) = mpsc::sync_channel(1);
        drop(std::mem::replace(&mut self.events, replacement));
        if let Some(mut session) = self.session.take() {
            let _ = session.stop();
        }
    }
}

fn executable() -> Result<PathBuf, String> {
    let path = if let Some(path) = std::env::var_os("ASH_VOICE_HOST_PATH") {
        PathBuf::from(path)
    } else {
        std::env::current_exe()
            .map_err(|error| error.to_string())?
            .parent()
            .ok_or("Cannot locate Ash executable directory")?
            .join(format!("ash-voice-host{}", std::env::consts::EXE_SUFFIX))
    };
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.is_file() {
        return Err("Audio helper is unavailable".into());
    }
    Ok(path)
}
