//! Both live capture and queued PCM use the account-bound ChatGPT dictation stream.

use crate::DictationEvent;
use crate::SubscriptionDictationRequest;
use crate::audio_input::AudioInput;
use crate::audio_input::AudioReceiver;
use async_utils::CancellationToken;
use model_provider::ChatGptDictationEvent;
use std::time::Duration;
use tokio::sync::oneshot;
use voice_host::SampleRate;

const MAX_SAMPLES: usize = 24_000 * 180;

pub(super) async fn run(
    request: SubscriptionDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    cancellation: CancellationToken,
    on_event: &dyn Fn(DictationEvent),
    input: Option<AudioReceiver>,
) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Ok(()),
        result = capture(request, stopped, on_event, input) => result,
    }
}

async fn capture(
    request: SubscriptionDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: &dyn Fn(DictationEvent),
    input: Option<AudioReceiver>,
) -> Result<(), String> {
    let mut stream = tokio::select! {
        _ = &mut *stopped => return Ok(()),
        result = request.dictation.connect(&request.connector, request.language.as_deref()) =>
            result.map_err(|error| error.to_string())?,
    };
    let mut audio = AudioInput::open(
        &request.audio_host,
        request.input_device,
        SampleRate::Hz24000,
        input,
    )
    .await?;
    let mut sample_count = 0;
    let mut account_check = tokio::time::interval(Duration::from_secs(1));
    account_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            result = &mut *stopped => {
                if result.is_err() { return Ok(()); }
                break;
            }
            _ = account_check.tick() => request.dictation.check_account().map_err(|error| error.to_string())?,
            event = stream.receive() => match event.map_err(|error| error.to_string())? {
                ChatGptDictationEvent::Transcript(text) => {
                    request.dictation.check_account().map_err(|error| error.to_string())?;
                    on_event(DictationEvent::Transcript { text, is_final: false });
                }
                ChatGptDictationEvent::Finished(_) => return Err("CodexDictationInvalidResponse".into()),
                ChatGptDictationEvent::Other => {}
            },
            chunk = audio.next_capture() => {
                let Some(samples) = chunk? else { break; };
                sample_count += samples.len();
                if sample_count > MAX_SAMPLES { return Err("CodexDictationAudioTooLong".into()); }
                tokio::time::timeout(Duration::from_secs(10), stream.append_pcm(&samples))
                    .await.map_err(|_| "CodexDictationRequestFailed")?
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    // Release the microphone before waiting for the remaining transcript.
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    if sample_count == 0 {
        return Ok(());
    }
    let text = tokio::time::timeout(Duration::from_secs(15), async {
        request
            .dictation
            .check_account()
            .map_err(|error| error.to_string())?;
        stream
            .finish_input()
            .await
            .map_err(|error| error.to_string())?;
        loop {
            match stream.receive().await.map_err(|error| error.to_string())? {
                ChatGptDictationEvent::Finished(text) => {
                    request
                        .dictation
                        .check_account()
                        .map_err(|error| error.to_string())?;
                    return Ok::<_, String>(text);
                }
                ChatGptDictationEvent::Transcript(text) => {
                    request
                        .dictation
                        .check_account()
                        .map_err(|error| error.to_string())?;
                    on_event(DictationEvent::Transcript {
                        text,
                        is_final: false,
                    });
                }
                ChatGptDictationEvent::Other => {}
            }
        }
    })
    .await
    .map_err(|_| "CodexDictationRequestFailed")??;
    on_event(DictationEvent::Transcript {
        text,
        is_final: true,
    });
    Ok(())
}
