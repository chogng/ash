use super::*;
use ash_protocol::CapabilitySupport;

#[test]
fn model_declaration_preserves_metadata_without_an_access_path() {
    let spec = crate::find_static_model(&ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-6.1-sol").unwrap(),
    ))
    .unwrap();
    let model = spec.model();
    assert_eq!(model.id.as_str(), "gpt-6.1-sol");
    assert_eq!(model.context_window, ContextWindow::Known(872_000));
    assert_eq!(model.capabilities.tools, CapabilitySupport::Supported);
    assert_eq!(
        model.default_reasoning_effort,
        Some(ReasoningEffort::Medium)
    );
    assert_eq!(model.access, ash_protocol::ModelAccess::Unknown);
}
