use super::*;

#[test]
fn explicit_false_overrides_enabled_defaults_and_keeps_source() {
    let overrides =
        serde_json::from_str::<FeatureOverrides>(r#"{"codeMode":false,"analytics":true}"#).unwrap();
    let values = resolve(&overrides);
    assert_eq!(
        values[0],
        FeatureState {
            feature: Feature::CodeMode,
            stage: FeatureStage::Stable,
            enabled: false,
            source: FeatureSource::User
        }
    );
    assert!(Feature::Analytics.enabled(&overrides));
    assert!(Feature::Queue.enabled(&overrides));
    assert_eq!(values[1].source, FeatureSource::Default);
}

#[test]
fn unknown_and_misspelled_keys_fail_at_the_config_boundary() {
    assert!(serde_json::from_str::<FeatureOverrides>(r#"{"code_mode":true}"#).is_err());
    assert!(serde_json::from_str::<FeatureOverrides>(r#"{"futureFeature":true}"#).is_err());
}

#[test]
fn memories_require_explicit_enablement_and_can_be_disabled_again() {
    assert!(!Feature::Memories.default_enabled());
    let mut overrides = FeatureOverrides::new();
    overrides.insert(Feature::Memories, true);
    assert!(Feature::Memories.enabled(&overrides));
    overrides.insert(Feature::Memories, false);
    assert!(!Feature::Memories.enabled(&overrides));
}
