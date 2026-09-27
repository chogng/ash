use super::*;
use ash_protocol::CapabilitySupport;

#[test]
fn model_declaration_preserves_metadata_without_an_access_path() {
    let spec = static_model! {
        provider: "test", id: "model", name: "Model",
        context_window: 1_000_000,
        capabilities: { tools: supported, },
        reasoning: [medium, high],
        model_reasoning_effort: high,
    };
    let model = spec.model();
    assert_eq!(model.id.as_str(), "model");
    assert_eq!(model.context_window, ContextWindow::Known(1_000_000));
    assert_eq!(model.capabilities.tools, CapabilitySupport::Supported);
    assert_eq!(model.model_reasoning_effort, Some(ReasoningEffort::High));
    assert_eq!(model.access, ash_protocol::ModelAccess::Unknown);
}
