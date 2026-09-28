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
