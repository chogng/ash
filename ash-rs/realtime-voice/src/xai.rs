//! xAI phrase boundaries update one draft; only audio.done completes the dictation session.
use crate::CloudDictationRequest;
use crate::DictationEvent;
use async_utils::CancellationSource;
use model_provider::XaiTranscriptionEvent;
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

#[derive(Default)]
struct Draft {
    committed: String,
    locked: String,
}

impl Draft {
    fn phrase(&mut self, text: &str) {
        append(&mut self.committed, text);
        self.locked.clear();
    }

    fn locked(&mut self, text: &str) {
        append(&mut self.locked, text);
    }

    fn preview(&self, text: &str) -> String {
        let mut result = self.committed.clone();
        append(&mut result, &self.locked);
        append(&mut result, text);
        result
    }

    fn finish(&self, text: &str) -> String {
        // transcript.done replaces the locked hypothesis and follows completed phrases.
        let mut result = self.committed.clone();
        append(&mut result, text);
        result
    }
}

fn append(target: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push(' ');
    }
    target.push_str(text);
}

pub(super) async fn run(
    request: CloudDictationRequest,
    stopped: &mut oneshot::Receiver<()>,
    on_event: &dyn Fn(DictationEvent),
) -> Result<(), String> {
    let model = ModelRef::new(
        ProviderId::new("xai").expect("built-in provider ID"),
        ModelId::new(&request.model_id).map_err(|error| error.to_string())?,
    );
    let token = CancellationSource::new().token();
    let mut session = tokio::select! {
        result = request.provider_runtime.connect_xai_transcription(
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
            rate: SampleRate::Hz16000,
            direction: Direction::Capture,
            processing: Processing::Speech,
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut draft = Draft::default();
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
                    XaiTranscriptionEvent::Partial { text, is_final, speech_final } => {
                        if speech_final {
                            draft.phrase(&text);
                            on_event(DictationEvent::Transcript { text: draft.preview(""), is_final: false });
                        } else if is_final {
                            draft.locked(&text);
                            on_event(DictationEvent::Transcript { text: draft.preview(""), is_final: false });
                        } else {
                            on_event(DictationEvent::Transcript { text: draft.preview(&text), is_final: false });
                        }
                    }
                    XaiTranscriptionEvent::Error { message } => return Err(message),
                    XaiTranscriptionEvent::Done { .. } => return Err("xAI transcription completed before audio.done".into()),
                    XaiTranscriptionEvent::Other => {}
                }
            }
        }
    }
    audio.stop().await.map_err(|error| error.to_string())?;
    audio.close().await.map_err(|error| error.to_string())?;
    session
        .finish(&token)
        .await
        .map_err(|error| error.to_string())?;
    let final_text = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match session
                .receive(&token)
                .await
                .map_err(|error| error.to_string())?
            {
                XaiTranscriptionEvent::Partial {
                    text,
                    is_final,
                    speech_final,
                } => {
                    if speech_final {
                        draft.phrase(&text);
                        on_event(DictationEvent::Transcript {
                            text: draft.preview(""),
                            is_final: false,
                        });
                    } else if is_final {
                        draft.locked(&text);
                        on_event(DictationEvent::Transcript {
                            text: draft.preview(""),
                            is_final: false,
                        });
                    } else {
                        on_event(DictationEvent::Transcript {
                            text: draft.preview(&text),
                            is_final: false,
                        });
                    }
                }
                XaiTranscriptionEvent::Done { text } => break Ok(draft.finish(&text)),
                XaiTranscriptionEvent::Error { message } => break Err(message),
                XaiTranscriptionEvent::Other => {}
            }
        }
    })
    .await
    .map_err(|_| "xAI transcription completion timed out")??;
    on_event(DictationEvent::Transcript {
        text: final_text,
        is_final: true,
    });
    session
        .close(&token)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "xai_tests.rs"]
mod tests;
