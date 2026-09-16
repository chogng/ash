use super::*;
use crate::ProviderConfigRegistry;
use crate::ProviderId;

fn openai() -> ProviderDefinition {
    ProviderConfigRegistry::builtin()
        .get(&ProviderId::new("openai").unwrap())
        .unwrap()
        .clone()
}

#[test]
fn voice_defaults_and_request_overrides_are_independent_of_text_models() {
    let provider = openai();
    let defaults = provider
        .resolve_voice(&VoiceModelConfig::default())
        .unwrap();
    assert_eq!(defaults.model.as_str(), "gpt-live-1");
    assert_eq!(defaults.voice, "marin");
    assert!(
        !provider
            .models
            .iter()
            .any(|model| model.id == defaults.model)
    );
    let saved = VoiceModelConfig {
        model: Some(defaults.model),
        voice: Some("cedar".into()),
    };
    assert_eq!(
        provider
            .resolve_voice(&saved.with_overrides(&VoiceModelConfig::default()))
            .unwrap()
            .voice,
        "cedar"
    );
    let request = VoiceModelConfig {
        model: None,
        voice: Some("coral".into()),
    };
    assert_eq!(
        provider
            .resolve_voice(&saved.with_overrides(&request))
            .unwrap()
            .voice,
        "coral"
    );
    let wrong_model = VoiceModelConfig {
        model: Some(ModelId::new("gpt-5.6-luna").unwrap()),
        voice: None,
    };
    assert!(matches!(
        provider.resolve_voice(&wrong_model),
        Err(ProviderConfigError::ModelNotRegistered { .. })
    ));
    assert!(
        provider
            .resolve_voice(&VoiceModelConfig {
                model: None,
                voice: Some("unsupported".into())
            })
            .is_err()
    );
}

#[test]
fn catalog_changes_do_not_require_model_names_in_the_runtime() {
    let mut provider = openai();
    let catalog = provider.voice_models.as_mut().unwrap();
    let mut model = catalog.models[0].clone();
    model.id = ModelId::new("fixture-speech-model").unwrap();
    catalog.default_model = model.id.clone();
    catalog.models.push(model);
    provider.validate().unwrap();
    assert_eq!(
        provider
            .resolve_voice(&VoiceModelConfig::default())
            .unwrap()
            .model
            .as_str(),
        "fixture-speech-model"
    );
    provider.voice_models.as_mut().unwrap().models[0]
        .voices
        .push("marin".into());
    assert!(provider.validate().is_err());
}

#[test]
fn voice_configuration_and_catalog_round_trip_and_require_explicit_protocol() {
    let provider = openai();
    let json = serde_json::to_value(&provider).unwrap();
    let restored: ProviderDefinition = serde_json::from_value(json).unwrap();
    assert_eq!(restored, provider);
    let selection: VoiceModelConfig =
        serde_json::from_str(r#"{"model":"gpt-live-1","voice":"cedar"}"#).unwrap();
    assert_eq!(
        serde_json::from_value::<VoiceModelConfig>(serde_json::to_value(&selection).unwrap())
            .unwrap(),
        selection
    );
    assert!(serde_json::from_str::<VoiceModelConfig>(r#"{"apiKey":"secret"}"#).is_err());
    let schema = schemars::schema_for!(VoiceModelConfig);
    assert!(serde_json::to_string(&schema).unwrap().contains("voice"));
    let mut unsupported = restored;
    unsupported.live_api_profile = LiveApiProfile::Unavailable;
    assert!(unsupported.validate().is_err());
    let text_only = ProviderConfigRegistry::builtin()
        .get(&ProviderId::new("anthropic").unwrap())
        .unwrap()
        .clone();
    assert!(
        text_only
            .resolve_voice(&VoiceModelConfig::default())
            .is_err()
    );
}
