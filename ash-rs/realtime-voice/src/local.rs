//! The selected ONNX package is ready before microphone capture begins.
use crate::DictationEvent;
use crate::LocalDictationRequest;
use crate::model_package::ModelPackage;
use async_utils::CancellationSource;
use sherpa_onnx::OnlineRecognizer;
use sherpa_onnx::OnlineRecognizerConfig;
use tokio::sync::oneshot;
use voice_host::AudioConfig;
use voice_host::AudioHost;
use voice_host::Direction;
use voice_host::Processing;
use voice_host::SampleRate;

pub(super) async fn run(
    request: LocalDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: &dyn Fn(DictationEvent),
) -> Result<(), String> {
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let package_future = ModelPackage::resolve(
        &request.model_root,
        &request.model_id,
        request.network,
        &token,
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
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.paraformer.encoder = Some(package.encoder.to_string_lossy().into_owned());
    config.model_config.paraformer.decoder = Some(package.decoder.to_string_lossy().into_owned());
    config.model_config.tokens = Some(package.tokens.to_string_lossy().into_owned());
    config.model_config.num_threads = 2;
    let recognizer =
        OnlineRecognizer::create(&config).ok_or("Could not load Paraformer dictation model")?;
    let stream = recognizer.create_stream();
    let mut audio = AudioHost::spawn(&request.audio_host)
        .await
        .map_err(|error| error.to_string())?;
    audio
        .start(AudioConfig {
            rate: SampleRate::Hz16000,
            direction: Direction::Capture,
            processing: Processing::Speech,
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut last_text = String::new();
    loop {
        tokio::select! {
            _ = &mut *stopped => break,
            capture = audio.next_capture() => {
                let capture = capture.map_err(|error| error.to_string())?;
                let waveform = capture.samples.iter().map(|sample| *sample as f32 / 32768.0).collect::<Vec<_>>();
                stream.accept_waveform(16000, &waveform);
                while recognizer.is_ready(&stream) {
                    recognizer.decode(&stream);
                }
                if let Some(result) = recognizer.get_result(&stream)
                    && result.text != last_text
                {
                    last_text = result.text.clone();
                    on_event(DictationEvent::Transcript { text: result.text, is_final: false });
                }
            }
        }
    }
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(result) = recognizer.get_result(&stream) {
        on_event(DictationEvent::Transcript {
            text: result.text,
            is_final: true,
        });
    }
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    Ok(())
}
