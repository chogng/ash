//! Local inference drains the renderer's PCM queue after the selected model is ready.
use crate::DictationEvent;
use crate::LocalDictationRequest;
use crate::LocalSpeechEvent;
use crate::LocalSpeechMode;
use crate::audio_input::AudioInput;
use crate::audio_input::AudioReceiver;
use crate::model_package::ModelPackage;
use crate::recognizer::Recognizer;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::oneshot;
use voice_host::SampleRate;

/// Startup warmup and recordings share one model. The lease prevents parallel loads.
#[derive(Default)]
pub(super) struct RecognizerCache {
    lease: AsyncMutex<()>,
    idle: Mutex<Option<(PathBuf, Recognizer)>>,
}

impl RecognizerCache {
    fn take(&self, package: &std::path::Path) -> Option<Recognizer> {
        let (cached, recognizer) = self.idle.lock().ok()?.take()?;
        (cached == package && recognizer.is_running()).then_some(recognizer)
    }

    fn store(&self, package: PathBuf, recognizer: Recognizer, cancellation: &CancellationToken) {
        if let Ok(mut cached) = self.idle.lock()
            && !cancellation.is_cancelled()
        {
            *cached = Some((package, recognizer));
        }
    }

    pub(super) fn forget(&self, package: &std::path::Path) {
        if let Ok(mut cached) = self.idle.lock()
            && cached.as_ref().is_some_and(|(path, _)| path == package)
        {
            cached.take();
        }
    }

    pub(super) async fn warm(
        &self,
        request: &crate::ModelRequest,
        cancellation: &CancellationToken,
        progress: &dyn Fn(crate::ModelProgress),
    ) -> Result<(), String> {
        let _lease = tokio::select! {
            _ = cancellation.cancelled() => return Err("Dictation model preparation cancelled".into()),
            lease = self.lease.lock() => lease,
        };
        let path = request.model_root.join(&request.model_id);
        if !path.join("dictation-model.json").is_file() {
            return Ok(());
        }
        let package = ModelPackage::read(&path)?;
        if self.idle.lock().is_ok_and(|cached| {
            cached
                .as_ref()
                .is_some_and(|(key, recognizer)| key == &path && recognizer.is_running())
        }) {
            return Ok(());
        }
        progress(crate::ModelProgress::Loading);
        let recognizer = package.recognizer(
            &request.home,
            &request.media_network,
            LocalSpeechMode::Dictation,
        )?;
        self.store(path, recognizer, cancellation);
        cancellation.check().map_err(|error| error.to_string())
    }
}

pub(super) async fn run(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: Arc<dyn Fn(DictationEvent) + Send + Sync>,
    input: Option<AudioReceiver>,
    cache: &RecognizerCache,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let _lease = match cache.lease.try_lock() {
        Ok(lease) => lease,
        Err(_) => {
            on_event(DictationEvent::ModelProgress(crate::ModelProgress::Loading));
            tokio::select! {
                _ = &mut *stopped => return Ok(()),
                lease = cache.lease.lock() => lease,
            }
        }
    };
    if cancellation.is_cancelled() {
        return Ok(());
    }
    run_with_audio(
        request,
        stopped,
        LocalSpeechMode::Dictation,
        Arc::new(move |event| match event {
            LocalSpeechEvent::ModelProgress(progress) => {
                on_event(DictationEvent::ModelProgress(progress))
            }
            LocalSpeechEvent::Ready => {}
            LocalSpeechEvent::Partial { text } => on_event(DictationEvent::Transcript {
                text,
                is_final: false,
            }),
            LocalSpeechEvent::Utterance { text } => on_event(DictationEvent::Transcript {
                text,
                is_final: true,
            }),
            LocalSpeechEvent::Ended { .. } => unreachable!("the session owner reports completion"),
        }),
        input,
        Some(cache),
        cancellation,
    )
    .await
}

pub(super) async fn run_session(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    mode: LocalSpeechMode,
    on_event: Arc<dyn Fn(LocalSpeechEvent) + Send + Sync>,
) -> Result<(), String> {
    run_with_audio(
        request,
        stopped,
        mode,
        on_event,
        None,
        None,
        &CancellationSource::new().token(),
    )
    .await
}

async fn run_with_audio(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    mode: LocalSpeechMode,
    on_event: Arc<dyn Fn(LocalSpeechEvent) + Send + Sync>,
    input: Option<AudioReceiver>,
    cache: Option<&RecognizerCache>,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    ModelPackage::validate_id(&request.model_id)?;
    let package_path = request.model_root.join(&request.model_id);
    let cached = cache
        .and_then(|cache| cache.take(&package_path))
        .filter(|_| ModelPackage::read(&package_path).is_ok());
    let recognizer = match cached {
        Some(recognizer) => recognizer,
        None => {
            let download = CancellationSource::new();
            let token = download.token();
            let progress_events = Arc::clone(&on_event);
            let package_future = ModelPackage::resolve(
                &request.home,
                &request.media_network,
                &request.model_root,
                &request.model_id,
                request.network,
                &token,
                Arc::new(move |progress| {
                    progress_events(LocalSpeechEvent::ModelProgress(progress))
                }),
            );
            tokio::pin!(package_future);
            let package = tokio::select! {
                result = &mut package_future => result?,
                _ = &mut *stopped => {
                    download.cancel();
                    let _ = package_future.await;
                    return Ok(());
                },
            };
            if cancellation.is_cancelled() {
                return Ok(());
            }
            on_event(LocalSpeechEvent::ModelProgress(
                crate::ModelProgress::Loading,
            ));
            package.recognizer(&request.home, &request.media_network, mode)?
        }
    };
    if cancellation.is_cancelled() {
        return Ok(());
    }
    on_event(LocalSpeechEvent::ModelProgress(crate::ModelProgress::Ready));
    let mut audio = AudioInput::open(
        &request.audio_host,
        request.input_device,
        SampleRate::Hz16000,
        input,
    )
    .await?;
    on_event(LocalSpeechEvent::Ready);
    let mut last_text = String::new();
    loop {
        tokio::select! {
            _ = &mut *stopped => break,
            capture = audio.next_capture() => {
                let Some(samples) = capture? else { break; };
                let result = recognizer.accept_audio(&samples).map_err(|error| error.to_string())?;
                if result.text != last_text {
                    last_text = result.text.clone();
                    on_event(LocalSpeechEvent::Partial { text: result.text.clone() });
                }
                if mode == LocalSpeechMode::Conversation && result.endpoint {
                    if !result.text.trim().is_empty() {
                        on_event(LocalSpeechEvent::Utterance { text: result.text });
                    }
                    recognizer.reset().map_err(|error| error.to_string())?;
                    last_text.clear();
                }
            }
        }
    }
    if cancellation.is_cancelled() {
        return audio.close().await;
    }
    let result = recognizer.finish()?;
    if mode == LocalSpeechMode::Dictation || !result.text.trim().is_empty() {
        on_event(LocalSpeechEvent::Utterance { text: result.text });
    }
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    if let Some(cache) = cache
        && !cancellation.is_cancelled()
        // A finished stream cannot accept another recording.
        && recognizer.restart_stream().is_ok()
    {
        cache.store(package_path, recognizer, cancellation);
    }
    Ok(())
}
