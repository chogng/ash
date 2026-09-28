//! One audio item stays open until stop commits it and returns the final transcript.
use crate::CloudDictationRequest;
use crate::DictationEvent;
use async_utils::CancellationSource;
use model_provider::TranscriptionEvent;
use protocol::ModelId;
use protocol::ModelRef;
use protocol::ProviderId;
use std::time::Duration;
use tokio::sync::oneshot;
use voice_host::AudioConfig;
use voice_host::AudioHost;
use voice_host::Direction;
use voice_host::Processing;
use voice_host::SampleRate;

pub(super) async fn run(
    request: CloudDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: &dyn Fn(DictationEvent),
) -> Result<(), String> {
    let provider = ProviderId::new("openai").expect("built-in provider ID");
    let model = ModelRef::new(
        provider,
        ModelId::new(&request.model_id).map_err(|error| error.to_string())?,
    );
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let mut session = tokio::select! {
        result = request.provider_runtime.connect_transcription(
            &request.provider_config,
            &model,
            &request.connector,
            model_provider::VoiceSessionLimits::default(),
            &token,
        ) => result.map_err(|error| error.to_string())?,
        _ = &mut *stopped => return Ok(()),
    };
    let mut audio = AudioHost::spawn(&request.audio_host)
        .await
        .map_err(|error| error.to_string())?;
    audio
        .start(AudioConfig {
            rate: SampleRate::Hz24000,
            direction: Direction::Capture,
            processing: Processing::Speech,
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut item_id = None;
    let mut partial = String::new();
    loop {
        tokio::select! {
            _ = &mut *stopped => break,
            capture = audio.next_capture() => {
                let capture = capture.map_err(|error| error.to_string())?;
                let pcm16 = capture.samples.iter().flat_map(|sample| sample.to_le_bytes()).collect::<Vec<_>>();
                session.append_audio(&pcm16, &token).await.map_err(|error| error.to_string())?;
            }
            event = session.receive(&token) => {
                match event.map_err(|error| error.to_string())? {
                    TranscriptionEvent::Delta { item_id: id, text } => {
                        if item_id.as_deref().is_some_and(|current| current != id) {
                            return Err("Transcription changed audio item before commit".into());
                        }
                        item_id = Some(id);
                        partial.push_str(&text);
                        on_event(DictationEvent::Transcript { text: partial.clone(), is_final: false });
                    }
                    TranscriptionEvent::Error { message } => return Err(message),
                    TranscriptionEvent::Completed { .. } => return Err("Transcription completed before audio commit".into()),
                    TranscriptionEvent::Other => {}
                }
            }
        }
    }
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    session
        .commit(&token)
        .await
        .map_err(|error| error.to_string())?;
    let final_text = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match session
                .receive(&token)
                .await
                .map_err(|error| error.to_string())?
            {
                TranscriptionEvent::Delta { item_id: id, text } => {
                    if item_id.as_deref().is_some_and(|current| current != id) {
                        return Err("Transcription changed audio item after commit".into());
                    }
                    item_id = Some(id);
                    partial.push_str(&text);
                    on_event(DictationEvent::Transcript {
                        text: partial.clone(),
                        is_final: false,
                    });
                }
                TranscriptionEvent::Completed { item_id: id, text } => {
                    if item_id.as_deref().is_some_and(|current| current != id) {
                        return Err("Transcription completion belongs to another audio item".into());
                    }
                    break Ok(text);
                }
                TranscriptionEvent::Error { message } => return Err(message),
                TranscriptionEvent::Other => {}
            }
        }
    })
    .await
    .map_err(|_| "Transcription completion timed out")??;
    on_event(DictationEvent::Transcript {
        text: final_text,
        is_final: true,
    });
    session
        .close(&token)
        .await
        .map_err(|error| error.to_string())
}
