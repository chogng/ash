//! Subscription dictation buffers one bounded recording and uploads only after an explicit stop.
use crate::audio_input::AudioInput;
use crate::audio_input::AudioReceiver;

use crate::DictationEvent;
use crate::SubscriptionDictationRequest;
use async_utils::CancellationToken;
use tokio::sync::oneshot;
use voice_host::SampleRate;

const SAMPLE_RATE: usize = 24_000;
const MAX_SAMPLES: usize = SAMPLE_RATE * 180;

pub(super) async fn run(
    request: SubscriptionDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    cancellation: CancellationToken,
    on_event: &dyn Fn(DictationEvent),
    input: Option<AudioReceiver>,
) -> Result<(), String> {
    let mut audio = AudioInput::open(
        &request.audio_host,
        request.input_device,
        SampleRate::Hz24000,
        input,
    )
    .await?;
    let mut samples = Vec::new();
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => { audio.close().await.map_err(|error| error.to_string())?; return Ok(()); }
            result = &mut *stopped => {
                if result.is_err() { return Ok(()); }
                break;
            }
            capture = audio.next_capture() => {
                let Some(chunk) = capture? else { break; };
                if samples.len() + chunk.len() > MAX_SAMPLES { return Err("CodexDictationAudioTooLong".into()); }
                samples.extend_from_slice(&chunk);
            }
        }
    }
    // Release the physical device before the potentially slow network request.
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    if samples.is_empty() || cancellation.is_cancelled() {
        return Ok(());
    }
    let wav = encode_wav(&samples);
    let token = cancellation.clone();
    let text = tokio::task::spawn_blocking(move || {
        request
            .dictation
            .transcribe(&wav, request.language.as_deref(), &token)
    })
    .await
    .map_err(|_| "CodexDictationRequestFailed")?
    .map_err(|error| error.to_string())?;
    if !cancellation.is_cancelled() {
        on_event(DictationEvent::Transcript {
            text,
            is_final: true,
        });
    }
    Ok(())
}

fn encode_wav(samples: &[i16]) -> Vec<u8> {
    let data_size = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    for value in [1u16, 1] {
        wav.extend_from_slice(&value.to_le_bytes());
    }
    wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    for value in [2u16, 16] {
        wav.extend_from_slice(&value.to_le_bytes());
    }
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;
