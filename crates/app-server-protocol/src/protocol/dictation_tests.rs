use super::DictationCloudProvider;
use super::DictationStartParams;
use serde_json::json;

#[test]
fn subscription_dictation_has_no_model_or_credentials_on_the_wire() {
    let request = json!({"resourceId":"subscription", "inputDevice":null, "language":"zh", "backend":{"type":"codex"}});
    let decoded: DictationStartParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), request);
    assert!(serde_json::from_value::<DictationStartParams>(json!({"resourceId":"subscription", "backend":{"type":"codex", "modelId":"gpt-live-transcribe"}})).is_err());
}

#[test]
fn renderer_pcm_input_is_explicit_and_device_capture_remains_the_default() {
    let pcm = json!({"resourceId":"turn", "backend":{"type":"codex"}, "inputDevice":null, "language":null, "audioInput":"pcm16"});
    let decoded: DictationStartParams = serde_json::from_value(pcm.clone()).unwrap();
    assert_eq!(decoded.audio_input, Some(super::DictationAudioInput::Pcm16));
    assert_eq!(serde_json::to_value(decoded).unwrap(), pcm);
    assert!(
        serde_json::from_value::<DictationStartParams>(
            json!({"resourceId":"turn","backend":{"type":"codex"},"audioInput":"unknown"})
        )
        .is_err()
    );
    let audio = json!({"resourceId":"turn","audio":"AAE="});
    let decoded: super::DictationAudioParams = serde_json::from_value(audio.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), audio);
}

#[test]
fn cloud_start_requires_a_declared_provider_and_model() {
    let request = json!({
        "resourceId": "speech-1",
        "inputDevice": "device-1",
        "language": "en",
        "backend": {
            "type": "cloud",
            "provider": "xai",
            "modelId": "grok-voice-transcribe-2.0"
        }
    });
    let decoded: DictationStartParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), request);
    assert!(
        serde_json::from_value::<DictationStartParams>(json!({
            "resourceId": "speech-1",
            "backend": { "type": "cloud", "modelId": "gpt-live-transcribe" }
        }))
        .is_err()
    );
    assert!(serde_json::from_value::<DictationCloudProvider>(json!("unknown")).is_err());
}

#[test]
fn model_operations_reject_cache_paths_and_unknown_stages() {
    use super::DictationModelProgress;
    use super::DictationModelStartParams;
    let request = json!({"resourceId":"model-1", "modelId":"custom", "operation":{"type":"import", "sourceDirectory":"C:/models/prepared"}});
    let decoded: DictationModelStartParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), request);
    assert!(serde_json::from_value::<DictationModelStartParams>(json!({"resourceId":"model-1", "modelId":"custom", "operation":{"type":"import", "sourceDirectory":"C:/models", "cacheDir":"C:/elsewhere"}})).is_err());
    let progress = json!({"resourceId":"model-1", "modelId":"custom", "stage":{"type":"downloading", "file":"encoder.onnx", "downloadedBytes":1048576}});
    let decoded: DictationModelProgress = serde_json::from_value(progress.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), progress);
    assert!(
        serde_json::from_value::<DictationModelProgress>(
            json!({"resourceId":"model-1", "modelId":"custom", "stage":{"type":"imaginary"}})
        )
        .is_err()
    );
}

#[test]
fn model_list_serializes_shared_preparation_and_installed_size() {
    let value = json!({"cacheDirectory":"C:/ash/dictation-models","packageVersion":1,"models":[{"modelId":"custom","available":false,"sizeBytes":0,"stage":{"type":"downloading","file":"encoder.onnx","downloadedBytes":1048576}}]});
    let decoded: super::DictationModelList = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    let changed = json!({"modelId":"custom"});
    let decoded: super::DictationModelChanged = serde_json::from_value(changed.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), changed);
}

#[test]
fn microphone_options_preserve_device_identity_and_model_language_capability() {
    let value = json!({"inputDevices":[{"id":"usb-1","label":"USB microphone","isDefault":true}],"languages":["en","zh"]});
    let decoded: super::DictationOptions = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
}
