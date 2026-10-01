//! Device-local dictation sessions. The product host owns connection identity and delivery;
//! this crate owns microphone exclusivity, recognition, and session teardown.

#[cfg(feature = "cloud")]
mod cloud;
mod local;
mod model_package;
mod models;
#[cfg(feature = "cloud")]
mod xai;

use http_client::OutboundNetworkSnapshot;
#[cfg(feature = "cloud")]
use model_provider::ModelProviderRuntime;
#[cfg(feature = "cloud")]
use model_provider_config::ModelProviderConfig;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use tokio::sync::oneshot;
#[cfg(feature = "cloud")]
use websocket_client::WebSocketConnector;

pub use model_package::DEFAULT_MODEL_ID;
pub use models::DictationModelManager;
pub use models::ModelOperation;
pub use models::ModelProgress;
pub use models::ModelRequest;

/// Selects the installed local model package and the audio helper for one session.
pub struct LocalDictationRequest {
    pub model_id: String,
    pub model_root: PathBuf,
    pub audio_host: PathBuf,
    pub network: OutboundNetworkSnapshot,
}

#[cfg(feature = "cloud")]
/// Cloud dictation uses a separate transcription session and direct model credentials.
pub struct CloudDictationRequest {
    pub provider: CloudTranscriptionProvider,
    pub model_id: String,
    pub audio_host: PathBuf,
    pub provider_runtime: Arc<ModelProviderRuntime>,
    pub provider_config: ModelProviderConfig,
    pub connector: WebSocketConnector,
}

#[cfg(feature = "cloud")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloudTranscriptionProvider {
    OpenAi,
    Xai,
}

pub enum DictationRequest {
    Local(LocalDictationRequest),
    #[cfg(feature = "cloud")]
    Cloud(CloudDictationRequest),
}

/// A local microphone session either fills a draft or emits completed spoken turns.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalSpeechMode {
    Dictation,
    Conversation,
}

/// Ordered recognition facts; only `Utterance` is suitable for submitting a user turn.
#[derive(Debug, Eq, PartialEq)]
pub enum LocalSpeechEvent {
    ModelProgress(ModelProgress),
    Ready,
    Partial { text: String },
    Utterance { text: String },
    Ended { error: Option<String> },
}

/// Owns capture on the user's machine, independently of the selected App Server.
pub struct LocalSpeechSession {
    stop: Option<oneshot::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LocalSpeechSession {
    pub fn start(
        request: LocalDictationRequest,
        mode: LocalSpeechMode,
        on_event: impl Fn(LocalSpeechEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let (stop, mut stopped) = oneshot::channel();
        let on_event: Arc<dyn Fn(LocalSpeechEvent) + Send + Sync> = Arc::new(on_event);
        let worker = thread::Builder::new()
            .name("ash-local-speech".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())
                    .and_then(|runtime| {
                        runtime.block_on(local::run_session(
                            request,
                            &mut stopped,
                            mode,
                            Arc::clone(&on_event),
                        ))
                    });
                on_event(LocalSpeechEvent::Ended {
                    error: result.err(),
                });
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            stop: Some(stop),
            worker: Some(worker),
        })
    }

    /// Stops capture and waits until its final utterance and completion events are delivered.
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "Local speech worker failed".to_owned())?;
        }
        Ok(())
    }
}

impl Drop for LocalSpeechSession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum DictationEvent {
    ModelProgress(ModelProgress),
    Transcript { text: String, is_final: bool },
    Ended { error: Option<String> },
}

/// A recognizer owns every resource needed to turn one live microphone session into text.
/// Implementations send ordered events to `on_event` and release their resources in `stop`.
trait Recognizer: Send + Sync {
    fn start(
        &self,
        request: DictationRequest,
        on_event: Box<dyn Fn(DictationEvent) + Send + Sync>,
    ) -> Result<Box<dyn RecognitionSession>, String>;
}

/// The active recognition session releases capture and inference before `stop` returns.
trait RecognitionSession: Send {
    fn stop(&mut self);
}

struct SessionRecognizer;

struct WorkerSession {
    stop: Option<oneshot::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Recognizer for SessionRecognizer {
    fn start(
        &self,
        request: DictationRequest,
        on_event: Box<dyn Fn(DictationEvent) + Send + Sync>,
    ) -> Result<Box<dyn RecognitionSession>, String> {
        let (stop, mut stopped) = oneshot::channel();
        let on_event: Arc<dyn Fn(DictationEvent) + Send + Sync> = Arc::from(on_event);
        let worker = thread::Builder::new()
            .name("ash-dictation".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())
                    .and_then(|runtime| {
                        runtime.block_on(async {
                            match request {
                                DictationRequest::Local(request) => {
                                    local::run(request, &mut stopped, Arc::clone(&on_event)).await
                                }
                                #[cfg(feature = "cloud")]
                                DictationRequest::Cloud(request) => {
                                    cloud::run(request, &mut stopped, on_event.as_ref()).await
                                }
                            }
                        })
                    });
                on_event(DictationEvent::Ended {
                    error: result.err(),
                });
            })
            .map_err(|error| error.to_string())?;
        Ok(Box::new(WorkerSession {
            stop: Some(stop),
            worker: Some(worker),
        }))
    }
}

impl RecognitionSession for WorkerSession {
    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct ActiveDictation {
    owner: u64,
    resource_id: String,
    session: Box<dyn RecognitionSession>,
    ended: Arc<AtomicBool>,
    final_text: Arc<Mutex<Option<String>>>,
}

/// One device-local dictation manager shared by all product connections in a process.
/// The owner and resource ID jointly identify the session; closing that owner releases it.
pub struct DictationManager {
    recognizer: Box<dyn Recognizer>,
    active: Mutex<Option<ActiveDictation>>,
}

impl Default for DictationManager {
    fn default() -> Self {
        Self {
            recognizer: Box::new(SessionRecognizer),
            active: Mutex::new(None),
        }
    }
}

impl DictationManager {
    pub fn is_active(&self) -> bool {
        self.active.lock().is_ok_and(|active| {
            active
                .as_ref()
                .is_some_and(|session| !session.ended.load(Ordering::Acquire))
        })
    }

    pub fn validate_resource_id(resource_id: &str) -> Result<(), String> {
        if resource_id.is_empty()
            || resource_id.len() > 128
            || !resource_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Invalid dictation resource ID".into());
        }
        Ok(())
    }

    pub fn start(
        &self,
        owner: u64,
        resource_id: String,
        request: DictationRequest,
        on_event: impl Fn(DictationEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        Self::validate_resource_id(&resource_id)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Dictation state unavailable")?;
        if active
            .as_ref()
            .is_some_and(|session| session.ended.load(Ordering::Acquire))
        {
            let mut completed = active.take().expect("validated completed dictation");
            completed.session.stop();
        }
        if active.is_some() {
            return Err("The microphone is already in use for dictation".into());
        }
        let ended = Arc::new(AtomicBool::new(false));
        let event_ended = Arc::clone(&ended);
        let final_text = Arc::new(Mutex::new(None));
        let event_final_text = Arc::clone(&final_text);
        let session = self.recognizer.start(
            request,
            Box::new(move |event| {
                if let DictationEvent::Transcript {
                    text,
                    is_final: true,
                } = &event
                    && let Ok(mut final_text) = event_final_text.lock()
                {
                    *final_text = Some(text.clone());
                }
                if matches!(event, DictationEvent::Ended { .. }) {
                    event_ended.store(true, Ordering::Release);
                }
                on_event(event);
            }),
        )?;
        *active = Some(ActiveDictation {
            owner,
            resource_id,
            session,
            ended,
            final_text,
        });
        Ok(())
    }

    pub fn stop(&self, owner: u64, resource_id: &str) -> Result<Option<String>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Dictation state unavailable")?;
        if active
            .as_ref()
            .is_none_or(|session| session.owner != owner || session.resource_id != resource_id)
        {
            return Err("Dictation session not found".into());
        }
        let mut session = active.take().expect("validated active dictation");
        session.session.stop();
        session
            .final_text
            .lock()
            .map(|text| text.clone())
            .map_err(|_| "Dictation state unavailable".into())
    }

    pub fn close(&self, owner: u64) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let mut session = if active
            .as_ref()
            .is_some_and(|session| session.owner == owner)
        {
            active.take()
        } else {
            None
        };
        if let Some(session) = session.as_mut() {
            session.session.stop();
        }
    }
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
