use super::DictationCloudProvider;
use super::DictationStartParams;
use serde_json::json;

#[test]
fn cloud_start_requires_a_declared_provider_and_model() {
    let request = json!({
        "resourceId": "speech-1",
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
