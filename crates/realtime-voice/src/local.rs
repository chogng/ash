//! The selected ONNX package is ready before microphone capture begins.
use crate::DictationEvent;
use crate::LocalDictationRequest;
use crate::LocalSpeechEvent;
use crate::LocalSpeechMode;
use crate::audio_input::AudioInput;
use crate::audio_input::AudioReceiver;
use crate::model_package::ModelPackage;
use async_utils::CancellationSource;
use std::sync::Arc;
use tokio::sync::oneshot;
use voice_host::SampleRate;

pub(super) async fn run(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: Arc<dyn Fn(DictationEvent) + Send + Sync>,
    input: Option<AudioReceiver>,
) -> Result<(), String> {
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
    )
    .await
}

pub(super) async fn run_session(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    mode: LocalSpeechMode,
    on_event: Arc<dyn Fn(LocalSpeechEvent) + Send + Sync>,
) -> Result<(), String> {
    run_with_audio(request, stopped, mode, on_event, None).await
}

async fn run_with_audio(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    mode: LocalSpeechMode,
    on_event: Arc<dyn Fn(LocalSpeechEvent) + Send + Sync>,
    input: Option<AudioReceiver>,
) -> Result<(), String> {
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let progress_events = Arc::clone(&on_event);
    let package_future = ModelPackage::resolve(
        &request.model_root,
        &request.model_id,
        request.network,
        &token,
        Arc::new(move |progress| progress_events(LocalSpeechEvent::ModelProgress(progress))),
    );
    tokio::pin!(package_future);
    let package = tokio::select! {
        result = &mut package_future => result?,
        _ = &mut *stopped => {
            cancellation.cancel();
            let _ = package_future.await;
            return Ok(());
        },
    };
    on_event(LocalSpeechEvent::ModelProgress(
        crate::ModelProgress::Loading,
    ));
    let recognizer = package.recognizer(mode)?;
    on_event(LocalSpeechEvent::ModelProgress(crate::ModelProgress::Ready));
    let stream = recognizer.create_stream();
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
                let waveform = samples.iter().map(|sample| *sample as f32 / 32768.0).collect::<Vec<_>>();
                stream.accept_waveform(16000, &waveform);
                while recognizer.is_ready(&stream) {
                    recognizer.decode(&stream);
                }
                if let Some(result) = recognizer.get_result(&stream) {
                    if result.text != last_text {
                        last_text = result.text.clone();
                        on_event(LocalSpeechEvent::Partial { text: result.text.clone() });
                    }
                    if mode == LocalSpeechMode::Conversation && recognizer.is_endpoint(&stream) {
                        if !result.text.trim().is_empty() {
                            on_event(LocalSpeechEvent::Utterance { text: result.text });
                        }
                        recognizer.reset(&stream);
                        last_text.clear();
                    }
                }
            }
        }
    }
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(result) = recognizer.get_result(&stream) {
        if mode == LocalSpeechMode::Dictation || !result.text.trim().is_empty() {
            on_event(LocalSpeechEvent::Utterance { text: result.text });
        }
    }
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    Ok(())
}
