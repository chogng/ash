use external_ext_sdk::CancellationToken;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use realtime_voice::recognizer::RecognitionInput;
use realtime_voice::recognizer::RecognitionMode;
use realtime_voice::recognizer::Request;
use realtime_voice::recognizer::Response;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

/// One inference session; the supervisor owns the process lifetime.
#[derive(Default)]
pub struct RecognitionHost(Arc<Mutex<Option<Recognition>>>);
struct Recognition {
    stream: sherpa_onnx::OnlineStream,
    recognizer: sherpa_onnx::OnlineRecognizer,
}
impl Extension for RecognitionHost {
    fn id(&self) -> &str {
        realtime_voice::recognizer::EXTENSION_ID
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let state = Self(Arc::clone(&self.0));
        context.data_channels.register(
            realtime_voice::recognizer::CHANNEL_ID,
            move |request, token| {
                token.check_cancelled()?;
                let result = state.request(request, &token);
                token.check_cancelled()?;
                Ok(result)
            },
        )
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        *self.0.lock().expect("recognition state") = None;
        Ok(())
    }
}
impl RecognitionHost {
    fn request(&self, request: Request, token: &CancellationToken) -> Result<Response, String> {
        match request {
            Request::OpenRecognizer {
                encoder,
                decoder,
                tokens,
                mode,
            } => {
                let mut state = self.0.lock().map_err(|_| "recognizer unavailable")?;
                if state.is_some() {
                    return Err("invalid media capability response".into());
                }
                for file in [&encoder, &decoder, &tokens] {
                    validate_model_file(file)?;
                }
                let mut config = sherpa_onnx::OnlineRecognizerConfig::default();
                config.model_config.paraformer.encoder =
                    Some(encoder.to_string_lossy().into_owned());
                config.model_config.paraformer.decoder =
                    Some(decoder.to_string_lossy().into_owned());
                config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
                config.model_config.num_threads = 2;
                if matches!(mode, RecognitionMode::Conversation) {
                    config.enable_endpoint = true;
                    config.rule1_min_trailing_silence = 2.4;
                    config.rule2_min_trailing_silence = 0.9;
                    config.rule3_min_utterance_length = 20.0;
                }
                let recognizer = sherpa_onnx::OnlineRecognizer::create(&config)
                    .ok_or_else(|| "Could not load Paraformer dictation model".to_owned())?;
                let stream = recognizer.create_stream();
                *state = Some(Recognition { stream, recognizer });
                Ok(Response::Done)
            }
            Request::Recognize { input } => {
                let (samples, finished) = match input {
                    RecognitionInput::Audio(samples) => (samples, false),
                    RecognitionInput::Finish => (Vec::new(), true),
                };
                if samples.len() > 32_000 {
                    return Err("invalid audio frame".into());
                }
                let state = self.0.lock().map_err(|_| "recognizer unavailable")?;
                let Some(resource) = &*state else {
                    return Err("invalid media capability response".into());
                };
                let waveform = samples
                    .iter()
                    .map(|sample| f32::from(*sample) / 32768.0)
                    .collect::<Vec<_>>();
                resource.stream.accept_waveform(16_000, &waveform);
                if finished {
                    resource.stream.input_finished();
                }
                while resource.recognizer.is_ready(&resource.stream) {
                    if token.is_cancellation_requested() {
                        return Err("recognition timed out".into());
                    }
                    resource.recognizer.decode(&resource.stream);
                }
                let text = resource
                    .recognizer
                    .get_result(&resource.stream)
                    .map(|result| result.text)
                    .unwrap_or_default();
                Ok(Response::Recognition {
                    text,
                    endpoint: resource.recognizer.is_endpoint(&resource.stream),
                })
            }
            Request::ResetRecognizer => {
                let state = self.0.lock().map_err(|_| "recognizer unavailable")?;
                let Some(resource) = &*state else {
                    return Err("invalid media capability response".into());
                };
                resource.recognizer.reset(&resource.stream);
                Ok(Response::Done)
            }
        }
    }
}
fn validate_model_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
    {
        return Err("invalid media capability response".into());
    }
    Ok(())
}
